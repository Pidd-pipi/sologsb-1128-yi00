import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { db } from '../db';
import { toPlain, uid } from '../utils/format';
import type { EmergencyStay } from '../types/emergency';
import type { EmergencyReleaseReason, ReassignmentNotice } from '../types/emergency';
import type { Berth } from '../types/berth';
import { useVesselStore } from './vesselStore';
import { usePortStore } from './portStore';
import { isCertificateExpired, pickEmergencyBerth } from '../utils/emergency';

export interface ApplyEmergencyInput {
  vesselId: string;
  portId: string;
  typhoonLevel: number;
  durationHours: number;
  vesselDraft: number;
}

export interface ApplyEmergencyResult {
  stay: EmergencyStay;
  displaced: { vesselId: string; vesselName: string } | null;
}

/**
 * 紧急回港限时占用：台风避险专用通道。
 * - 证书过期也可进入；
 * - 同一泊位同一时段只留一条有效占用（靠事务内复检保证）；
 * - 同一艘船只能持有一条生效中的紧急占用；
 * - 需挤用时挤掉现有占用排位最末的普通船，并生成改派提醒；
 * - 到期自动释放，记录全程保留。
 */
export const useEmergencyStore = defineStore('emergency', () => {
  const stays = ref<EmergencyStay[]>([]);
  const notices = ref<ReassignmentNotice[]>([]);
  const loading = ref(false);
  /** 自动扫描定时器，每次进入页面时驱动一次 nowTick，用于倒计时刷新 */
  const nowTick = ref(Date.now());

  const activeStays = computed(() =>
    stays.value
      .filter((s) => s.status === '生效中' && new Date(s.expireAt).getTime() > nowTick.value)
      .sort((a, b) => new Date(a.expireAt).getTime() - new Date(b.expireAt).getTime()),
  );

  /** 已超时但尚未落库释放的占用（sweep 后清空） */
  const overdueStays = computed(() =>
    stays.value.filter((s) => s.status === '生效中' && new Date(s.expireAt).getTime() <= nowTick.value),
  );

  const historyStays = computed(() =>
    stays.value
      .filter((s) => s.status === '已释放')
      .sort((a, b) => new Date(b.releasedAt ?? b.expireAt).getTime() - new Date(a.releasedAt ?? a.expireAt).getTime()),
  );

  const unreadNotices = computed(() => notices.value.filter((n) => !n.read));
  const noticesSorted = computed(() =>
    [...notices.value].sort((a, b) => new Date(b.displacedAt).getTime() - new Date(a.displacedAt).getTime()),
  );

  function stayById(id: string): EmergencyStay | undefined {
    return stays.value.find((s) => s.id === id);
  }

  function activeStayOfVessel(vesselId: string): EmergencyStay | undefined {
    return stays.value.find((s) => s.vesselId === vesselId && s.status === '生效中');
  }

  /** 该船当前是否已在任何渔港有有效占用（普通或紧急） */
  async function vesselOccupiedAnywhere(vesselId: string, excludeStayId = ''): Promise<Berth | undefined> {
    return db.berths
      .where('vesselId')
      .equals(vesselId)
      .filter((b) => b.status === '占用' && b.emergencyStayId !== excludeStayId)
      .first();
  }

  async function loadAll(): Promise<void> {
    loading.value = true;
    try {
      const [s, n] = await Promise.all([db.emergencyStays.toArray(), db.reassignNotices.toArray()]);
      stays.value = s;
      notices.value = n;
    } finally {
      loading.value = false;
    }
  }

  /**
   * 办理紧急回港。整个抢占过程在一个 Dexie 事务内完成：
   * 事务提交前再次从库里复检「同船占用 / 同泊位占用」，避免并发重复提交多占。
   */
  async function applyEmergency(input: ApplyEmergencyInput): Promise<ApplyEmergencyResult> {
    const vesselStore = useVesselStore();
    const portStore = usePortStore();

    const vessel = vesselStore.vesselById(input.vesselId);
    if (!vessel) throw new Error('请选择有效的渔船');
    const port = portStore.portById(input.portId);
    if (!port) throw new Error('请选择避风渔港');
    const duration = Number(input.durationHours);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('停留时长需为正数小时');
    if (duration > 72) throw new Error('紧急避险限时占用最长 72 小时，超时请重新申报');
    if (port.shelterLevel < Number(input.typhoonLevel)) {
      throw new Error(`${port.name}避风能力仅 ${port.shelterLevel} 级，不足以抵御 ${input.typhoonLevel} 级台风`);
    }

    // 同一艘船重复提交不能多占（内存层先挡一道）
    if (activeStayOfVessel(vessel.id)) {
      throw new Error(`${vessel.name} 已有一条生效中的紧急占用，同一艘船不能重复申报多占`);
    }

    // 事务外先按排位规则挑泊位（展示给值班员确认用），真正写入在事务内复检
    const portBerths = portStore.berthsOf(port.id);
    const plan = pickEmergencyBerth(port, portBerths, input.vesselDraft, input.typhoonLevel);
    if (!plan) {
      if (portBerths.every((b) => b.status === '维修' || b.designDepth < input.vesselDraft)) {
        throw new Error(`${port.name}没有水深 ≥ ${input.vesselDraft}m 且可使用的泊位，无法接纳该船`);
      }
      throw new Error(`${port.name}既无空闲泊位，也没有可挤让的普通船（紧急船之间不可互挤）`);
    }

    const now = new Date();
    const startAt = now.toISOString();
    const expireAt = new Date(now.getTime() + duration * 3600 * 1000).toISOString();
    const stayId = uid('e');

    const stay: EmergencyStay = {
      id: stayId,
      vesselId: vessel.id,
      vesselName: vessel.name,
      portId: port.id,
      portName: port.name,
      berthId: plan.berth.id,
      berthNo: plan.berth.berthNo,
      typhoonLevel: Number(input.typhoonLevel),
      vesselDraft: Number(input.vesselDraft),
      durationHours: duration,
      startAt,
      expireAt,
      status: '生效中',
      releasedAt: null,
      releaseReason: null,
      certificateExpired: isCertificateExpired(vessel, now),
      displacedVesselId: plan.displaced?.vesselId ?? null,
      displacedVesselName: plan.displaced?.vesselName ?? null,
      displacedAt: plan.displaced ? startAt : null,
      createdAt: startAt,
    };

    let notice: ReassignmentNotice | null = null;

    await db.transaction('rw', db.berths, db.emergencyStays, db.reassignNotices, async () => {
      // 事务内复检 1：同船是否已在别处占用（含普通与紧急）
      const dupVessel = await db.berths
        .where('vesselId')
        .equals(vessel.id)
        .filter((b) => b.status === '占用')
        .first();
      if (dupVessel) {
        throw new Error(`${vessel.name} 已在 ${dupVessel.berthNo} 占用中，同一艘船不能多占`);
      }

      const latest = await db.berths.get(plan.berth.id);
      if (!latest) throw new Error('泊位记录缺失，请刷新后重试');

      // 事务内复检 2：同一泊位同一时段只留一条有效占用
      if (latest.status === '维修') {
        throw new Error(`${latest.berthNo} 处于维修状态，不能安排紧急回港`);
      }
      if (latest.designDepth < input.vesselDraft) {
        throw new Error(`${latest.berthNo} 水深不足，无法容纳该船`);
      }
      if (latest.status === '占用') {
        if (latest.occupyKind === '紧急' || !latest.vesselId) {
          throw new Error(`${latest.berthNo} 已被另一条紧急占用，紧急船之间不可互挤`);
        }
        // 挤掉排位最末的普通船
        const displacedVesselId = latest.vesselId;
        const displacedVesselName = latest.vesselName ?? '未知船舶';
        const displacedAt = new Date().toISOString();

        notice = {
          id: uid('n'),
          stayId,
          vesselId: displacedVesselId,
          vesselName: displacedVesselName,
          portId: port.id,
          portName: port.name,
          berthNo: latest.berthNo,
          displacedAt,
          suggestion: buildSuggestion(port.name, latest.berthNo, displacedVesselName, input.typhoonLevel),
          read: false,
          createdAt: displacedAt,
        };
        // 普通船改派提醒先入库；其原泊位立即让给紧急船
        await db.reassignNotices.put(toPlain(notice));
      }

      const nextBerth: Berth = {
        ...latest,
        status: '占用',
        vesselId: vessel.id,
        vesselName: vessel.name,
        berthAt: startAt,
        leaveAt: null,
        occupyKind: '紧急',
        expireAt,
        emergencyStayId: stayId,
      };
      await db.emergencyStays.put(toPlain(stay));
      await db.berths.put(toPlain(nextBerth));
    });

    stays.value = [...stays.value, stay];
    if (notice) notices.value = [...notices.value, notice];
    // 事务后以库中最新状态同步 portStore，保证详情页 / 地图 / 档案读到同一临时占用
    await portStore.syncBerthFromDb(plan.berth.id);
    nowTick.value = Date.now();

    return { stay, displaced: plan.displaced ? { vesselId: plan.displaced.vesselId, vesselName: plan.displaced.vesselName } : null };
  }

  /** 释放一条紧急占用（手动或超时），释放后记录保留 */
  async function releaseStay(stayId: string, reason: EmergencyReleaseReason): Promise<EmergencyStay | null> {
    const stay = stays.value.find((s) => s.id === stayId);
    if (!stay || stay.status !== '生效中') return null;

    const releasedAt = new Date().toISOString();
    const nextStay: EmergencyStay = { ...stay, status: '已释放', releasedAt, releaseReason: reason };

    await db.transaction('rw', db.berths, db.emergencyStays, async () => {
      const berth = await db.berths.get(stay.berthId);
      // 只有仍由本紧急占用持有的泊位才释放（被其他流程改动过则只关单）
      if (berth && berth.status === '占用' && berth.emergencyStayId === stay.id) {
        const freed: Berth = {
          ...berth,
          status: '空闲',
          vesselId: null,
          vesselName: null,
          berthAt: null,
          leaveAt: releasedAt,
          occupyKind: '普通',
          expireAt: null,
          emergencyStayId: null,
        };
        await db.berths.put(toPlain(freed));
      }
      await db.emergencyStays.put(toPlain(nextStay));
    });

    stays.value = stays.value.map((s) => (s.id === stayId ? nextStay : s));
    const portStore = usePortStore();
    await portStore.syncBerthFromDb(stay.berthId);
    nowTick.value = Date.now();
    return nextStay;
  }

  /** 扫描并释放所有已到期的生效占用，返回本次释放条数 */
  async function sweepExpired(): Promise<EmergencyStay[]> {
    nowTick.value = Date.now();
    const due = stays.value.filter(
      (s) => s.status === '生效中' && new Date(s.expireAt).getTime() <= Date.now(),
    );
    const released: EmergencyStay[] = [];
    for (const stay of due) {
      const next = await releaseStay(stay.id, '超时释放');
      if (next) released.push(next);
    }
    return released;
  }

  async function markNoticeRead(noticeId: string, read = true): Promise<void> {
    const hit = notices.value.find((n) => n.id === noticeId);
    if (!hit || hit.read === read) return;
    const next = { ...hit, read };
    await db.reassignNotices.put(toPlain(next));
    notices.value = notices.value.map((n) => (n.id === noticeId ? next : n));
  }

  async function markAllNoticesRead(): Promise<void> {
    const unread = notices.value.filter((n) => !n.read);
    if (!unread.length) return;
    const nextList = notices.value.map((n) => (n.read ? n : { ...n, read: true }));
    await db.reassignNotices.bulkPut(toPlain(nextList));
    notices.value = nextList;
  }

  return {
    stays,
    notices,
    loading,
    nowTick,
    activeStays,
    overdueStays,
    historyStays,
    unreadNotices,
    noticesSorted,
    stayById,
    activeStayOfVessel,
    vesselOccupiedAnywhere,
    loadAll,
    applyEmergency,
    releaseStay,
    sweepExpired,
    markNoticeRead,
    markAllNoticesRead,
  };
});

function buildSuggestion(portName: string, berthNo: string, vesselName: string, typhoonLevel: number): string {
  return `${vesselName}：原 ${portName} ${berthNo} 泊位已让给 ${typhoonLevel} 级台风紧急避险船，请凭本提醒改派其他空闲泊位或前往避风等级适配的邻近渔港`;
}
