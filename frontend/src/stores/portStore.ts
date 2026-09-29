import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { db } from '../db';
import { toPlain, uid } from '../utils/format';
import { emptyPortFilter, type FishingPort, type PortFilter, type SupplyCapability } from '../types/port';
import type { Berth, BerthStatus } from '../types/berth';
import type { CallDraft, PortCall } from '../types/call';
import type { EmergencyShelter, RerouteNotice, ShelterDraft } from '../types/shelter';
import type { FishingVessel } from '../types/vessel';
import { buildBerthRecords } from '../db/berth';
import { isCertificateExpired, requiredDepthM, suggestReroutePort } from '../utils/shelter';

export interface PortInput {
  name: string;
  level: FishingPort['level'];
  longitude: number;
  latitude: number;
  berthCount: number;
  berthDepth: number;
  wharfLength: number;
  shelterLevel: number;
  supply: SupplyCapability;
  manager: string;
}

/** 紧急回港申请结果（业务规则不满足时 ok=false，由页面给出具体提示） */
export interface EmergencyResult {
  ok: boolean;
  message: string;
  shelter?: EmergencyShelter;
  /** 是否挤掉了普通船 */
  displaced: boolean;
  /** 改派建议文案 */
  suggestion: string;
}

export const usePortStore = defineStore('port', () => {
  const ports = ref<FishingPort[]>([]);
  const berths = ref<Berth[]>([]);
  const calls = ref<PortCall[]>([]);
  const shelters = ref<EmergencyShelter[]>([]);
  const rerouteNotices = ref<RerouteNotice[]>([]);
  const loading = ref(false);
  const filter = ref<PortFilter>(emptyPortFilter());

  const filteredPorts = computed(() => {
    const f = filter.value;
    const keyword = f.keyword.trim();
    return ports.value.filter((p) => {
      if (f.level && p.level !== f.level) return false;
      if (f.minShelterLevel !== null && p.shelterLevel < f.minShelterLevel) return false;
      if (keyword && !p.name.includes(keyword) && !p.manager.includes(keyword)) return false;
      return true;
    });
  });

  const callsSorted = computed(() =>
    [...calls.value].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()),
  );

  /** 有效紧急占用（按到期时间升序） */
  const activeShelters = computed(() =>
    shelters.value
      .filter((s) => s.status === '有效' && new Date(s.expiresAt).getTime() > Date.now())
      .sort((a, b) => new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime()),
  );

  /** 历史紧急占用（已完成 / 已超时，按释放时间倒序） */
  const shelterHistory = computed(() =>
    shelters.value
      .filter((s) => s.status !== '有效' || new Date(s.expiresAt).getTime() <= Date.now())
      .sort((a, b) => (b.releasedAt ?? b.expiresAt).localeCompare(a.releasedAt ?? a.expiresAt)),
  );

  /** 待处理改派提醒 */
  const pendingNotices = computed(() =>
    [...rerouteNotices.value]
      .filter((n) => !n.handled)
      .sort((a, b) => b.displacedAt.localeCompare(a.displacedAt)),
  );

  function portById(id: string): FishingPort | undefined {
    return ports.value.find((p) => p.id === id);
  }

  function berthsOf(portId: string): Berth[] {
    return berths.value.filter((b) => b.portId === portId).sort((a, b) => a.berthNo.localeCompare(b.berthNo));
  }

  function callsOfVessel(vesselId: string): PortCall[] {
    return callsSorted.value.filter((c) => c.vesselId === vesselId);
  }

  /** 该船当前有效的紧急占用（同一艘船同时只能有一条） */
  function activeShelterOfVessel(vesselId: string): EmergencyShelter | undefined {
    return shelters.value.find(
      (s) => s.vesselId === vesselId && s.status === '有效' && new Date(s.expiresAt).getTime() > Date.now(),
    );
  }

  /** 该船的全部紧急占用记录（含历史） */
  function sheltersOfVessel(vesselId: string): EmergencyShelter[] {
    return [...shelters.value]
      .filter((s) => s.vesselId === vesselId)
      .sort((a, b) => b.berthAt.localeCompare(a.berthAt));
  }

  /** 该泊位当前有效的紧急占用 */
  function activeShelterOfBerth(portId: string, berthNo: string): EmergencyShelter | undefined {
    return shelters.value.find(
      (s) =>
        s.portId === portId &&
        s.berthNo === berthNo &&
        s.status === '有效' &&
        new Date(s.expiresAt).getTime() > Date.now(),
    );
  }

  function shelterById(id: string): EmergencyShelter | undefined {
    return shelters.value.find((s) => s.id === id);
  }

  function noticesOfVessel(vesselId: string): RerouteNotice[] {
    return [...rerouteNotices.value]
      .filter((n) => n.vesselId === vesselId)
      .sort((a, b) => b.displacedAt.localeCompare(a.displacedAt));
  }

  function resetFilter(): void {
    filter.value = emptyPortFilter();
  }

  async function loadAll(): Promise<void> {
    loading.value = true;
    try {
      const [p, b, c, s, n] = await Promise.all([
        db.ports.toArray(),
        db.berths.toArray(),
        db.calls.toArray(),
        db.shelters.toArray(),
        db.rerouteNotices.toArray(),
      ]);
      ports.value = p;
      berths.value = b;
      calls.value = c;
      shelters.value = s;
      rerouteNotices.value = n;
    } finally {
      loading.value = false;
    }
  }

  async function createPort(input: PortInput): Promise<FishingPort> {
    const port: FishingPort = {
      id: uid('p'),
      name: input.name.trim(),
      level: input.level,
      longitude: Number(input.longitude),
      latitude: Number(input.latitude),
      berthCount: Number(input.berthCount),
      berthDepth: Number(input.berthDepth),
      wharfLength: Number(input.wharfLength),
      shelterLevel: Number(input.shelterLevel),
      supply: { ...input.supply },
      manager: input.manager.trim(),
      createdAt: new Date().toISOString(),
    };
    // 写库前脱代理，避免 DataCloneError
    await db.ports.put(toPlain(port));
    const records = buildBerthRecords(port, []);
    await db.berths.bulkPut(toPlain(records));
    ports.value = [...ports.value, port];
    berths.value = [...berths.value, ...records];
    return port;
  }

  async function addBerth(portId: string, berthNo: string, designDepth: number): Promise<Berth | null> {
    const port = portById(portId);
    if (!port) return null;
    const no = berthNo.trim().toUpperCase();
    if (!no) return null;
    if (berthsOf(portId).some((b) => b.berthNo === no)) return null;
    const berth: Berth = {
      id: `${portId}-${no}`,
      portId,
      berthNo: no,
      vesselId: null,
      vesselName: null,
      berthAt: null,
      leaveAt: null,
      status: '空闲',
      designDepth: Number(designDepth) || port.berthDepth,
      occupancyKind: undefined,
      emergencyId: null,
      expiresAt: null,
      typhoonLevel: null,
    };
    await db.berths.put(toPlain(berth));
    berths.value = [...berths.value, berth];
    const nextCount = berthsOf(portId).length;
    await updatePort(portId, { berthCount: nextCount });
    return berth;
  }

  async function setBerthStatus(berthId: string, status: BerthStatus): Promise<void> {
    const hit = berths.value.find((b) => b.id === berthId);
    if (!hit) return;
    const next: Berth = {
      ...hit,
      status,
      vesselId: status === '占用' ? hit.vesselId : null,
      vesselName: status === '占用' ? hit.vesselName : null,
      berthAt: status === '占用' ? hit.berthAt ?? new Date().toISOString() : hit.berthAt,
      leaveAt: status === '空闲' ? new Date().toISOString() : null,
      // 手动置为空闲 / 维修时清掉紧急占用标记（紧急释放走 completeShelter / sweepExpired）
      occupancyKind: status === '占用' ? hit.occupancyKind : undefined,
      emergencyId: status === '占用' ? hit.emergencyId ?? null : null,
      expiresAt: status === '占用' ? hit.expiresAt ?? null : null,
      typhoonLevel: status === '占用' ? hit.typhoonLevel ?? null : null,
    };
    await db.berths.put(toPlain(next));
    berths.value = berths.value.map((b) => (b.id === berthId ? next : b));
  }

  async function updatePort(portId: string, patch: Partial<FishingPort>): Promise<void> {
    const hit = portById(portId);
    if (!hit) return;
    const next: FishingPort = { ...hit, ...patch };
    await db.ports.put(toPlain(next));
    ports.value = ports.value.map((p) => (p.id === portId ? next : p));
  }

  /**
   * 登记一条进出港记录，并同步泊位占用状态（进港 → 占用，出港 → 释放）。
   * 普通进港仍按证书拦截：证书过期渔船的进港申请会被拒绝（紧急避风请走紧急回港）。
   */
  async function registerCall(draft: CallDraft, vesselName: string, portId: string): Promise<PortCall> {
    const berth = berths.value.find((b) => b.portId === portId && b.berthNo === draft.berthNo);
    if (draft.type === '进港') {
      const vessel = await db.vessels.get(draft.vesselId);
      if (vessel && isCertificateExpired(vessel)) {
        throw new Error(`证书已于 ${vessel.certificateExpiry} 过期，普通进港被拦截；台风期间请走「紧急回港」`);
      }
      if (berth?.occupancyKind === '紧急') {
        throw new Error(`泊位 ${draft.berthNo} 正被台风紧急避风船占用，普通进港不可使用`);
      }
      if (berth?.status === '占用') {
        throw new Error(`泊位 ${draft.berthNo} 已被 ${berth.vesselName ?? '其他船'} 占用，请先办理出港或改用空闲泊位`);
      }
    }
    if (draft.type === '出港' && berth?.occupancyKind === '紧急') {
      throw new Error(`泊位 ${draft.berthNo} 为台风紧急避风占用，请在「紧急回港」页办理限时离港`);
    }

    const call: PortCall = {
      id: uid('c'),
      vesselId: draft.vesselId,
      vesselName,
      type: draft.type,
      time: draft.time ? new Date(draft.time).toISOString() : new Date().toISOString(),
      berthNo: draft.berthNo,
      iceKg: Number(draft.iceKg) || 0,
      fuelL: Number(draft.fuelL) || 0,
      unloadKg: Number(draft.unloadKg) || 0,
      visaStatus: draft.visaStatus,
      createdAt: new Date().toISOString(),
    };
    await db.calls.put(toPlain(call));
    calls.value = [...calls.value, call];

    if (berth) {
      const next: Berth =
        draft.type === '进港'
          ? {
              ...berth,
              status: '占用',
              vesselId: draft.vesselId,
              vesselName,
              berthAt: call.time,
              leaveAt: null,
              occupancyKind: '普通',
              emergencyId: null,
              expiresAt: null,
              typhoonLevel: null,
            }
          : {
              ...berth,
              status: '空闲',
              vesselId: null,
              vesselName: null,
              berthAt: null,
              leaveAt: call.time,
              occupancyKind: undefined,
              emergencyId: null,
              expiresAt: null,
              typhoonLevel: null,
            };
      await db.berths.put(toPlain(next));
      berths.value = berths.value.map((b) => (b.id === berth.id ? next : b));
    }
    return call;
  }

  /**
   * 台风紧急回港：值班员选好渔港与停留时长后申请限时占用。
   * - 校验避风等级（渔港能扛住本次台风）与水深；
   * - 同一艘船已有有效紧急占用时拒绝重复提交；
   * - 泊位空闲 → 直接占用；被普通船占用 → 挤掉最早靠泊的普通船并生成改派提醒；
   * - 紧急占用泊位不可再被挤占，同一泊位同一时段只留一条有效占用。
   */
  async function requestEmergencyShelter(
    draft: ShelterDraft,
    vessel: Pick<FishingVessel, 'id' | 'name' | 'grossTonnage'>,
  ): Promise<EmergencyResult> {
    const port = portById(draft.portId);
    if (!port) return { ok: false, displaced: false, suggestion: '', message: '请选择避风渔港' };
    const hours = Number(draft.durationHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      return { ok: false, displaced: false, suggestion: '', message: '停留时长需大于 0 小时' };
    }
    if (port.shelterLevel < Number(draft.typhoonLevel)) {
      return {
        ok: false,
        displaced: false,
        suggestion: '',
        message: `该渔港避风能力 ${port.shelterLevel} 级，扛不住 ${draft.typhoonLevel} 级台风，请另选渔港`,
      };
    }
    const berth = berths.value.find((b) => b.portId === port.id && b.berthNo === draft.berthNo);
    if (!berth) return { ok: false, displaced: false, suggestion: '', message: '请选择泊位' };
    const requiredDepth = requiredDepthM(vessel);
    if (berth.status === '维修') {
      return { ok: false, displaced: false, suggestion: '', message: `泊位 ${berth.berthNo} 正在维修，不可避风停靠` };
    }
    if (berth.designDepth + 1e-9 < requiredDepth) {
      return {
        ok: false,
        displaced: false,
        suggestion: '',
        message: `泊位水深 ${berth.designDepth}m 不足，本船安全靠泊至少需要 ${requiredDepth}m`,
      };
    }

    // 同一艘船重复提交不能多占
    const ownActive = activeShelterOfVessel(vessel.id);
    if (ownActive) {
      return {
        ok: false,
        displaced: false,
        suggestion: '',
        message: `该船已在 ${ownActive.portName} ${ownActive.berthNo} 紧急避风（${hoursLabel(ownActive.durationHours)}内有效），不可重复提交`,
      };
    }

    // 同一泊位同一时段只留一条有效占用：紧急占用不可被挤
    const berthActive = activeShelterOfBerth(port.id, berth.berthNo);
    if (berthActive) {
      return {
        ok: false,
        displaced: false,
        suggestion: '',
        message: `泊位 ${berth.berthNo} 已被紧急船 ${berthActive.vesselName} 限时占用`,
      };
    }

    const now = new Date();
    const berthAtIso = now.toISOString();
    const expiresAtIso = new Date(now.getTime() + hours * 3600 * 1000).toISOString();
    const selfOccupied = berth.status === '占用' && berth.vesselId === vessel.id;
    const displacedOrdinary = berth.status === '占用' && !selfOccupied ? berth : null;

    const shelter: EmergencyShelter = {
      id: uid('e'),
      portId: port.id,
      portName: port.name,
      berthNo: berth.berthNo,
      vesselId: vessel.id,
      vesselName: vessel.name,
      typhoonLevel: Number(draft.typhoonLevel),
      shelterLevel: port.shelterLevel,
      berthDepth: berth.designDepth,
      requiredDepth,
      durationHours: hours,
      berthAt: berthAtIso,
      expiresAt: expiresAtIso,
      releasedAt: null,
      displacedVesselId: selfOccupied ? null : displacedOrdinary?.vesselId ?? null,
      displacedVesselName: selfOccupied ? null : displacedOrdinary?.vesselName ?? null,
      status: '有效',
      remark: selfOccupied ? '该船原普通占用转为紧急避风占用' : '',
      createdAt: berthAtIso,
    };

    let notice: RerouteNotice | null = null;
    let suggestionText = '';
    if (displacedOrdinary && displacedOrdinary.vesselId) {
      const suggestion = suggestReroutePort(
        ports.value,
        (portId) => berthsOf(portId),
        requiredDepth,
        shelter.typhoonLevel,
        port.id,
      );
      notice = {
        id: uid('n'),
        vesselId: displacedOrdinary.vesselId,
        vesselName: displacedOrdinary.vesselName ?? '未知船舶',
        portId: port.id,
        portName: port.name,
        berthNo: berth.berthNo,
        shelterId: shelter.id,
        emergencyVesselName: vessel.name,
        typhoonLevel: shelter.typhoonLevel,
        displacedAt: berthAtIso,
        suggestionPortId: suggestion?.port.id ?? null,
        suggestionPortName: suggestion?.port.name ?? null,
        suggestionBerthNo: suggestion?.berth.berthNo ?? null,
        handled: false,
        handleNote: '',
        createdAt: berthAtIso,
      };
      suggestionText = suggestion
        ? `建议改派至 ${suggestion.port.name} ${suggestion.berth.berthNo}（避风 ${suggestion.port.shelterLevel} 级 · 水深 ${suggestion.berth.designDepth}m）`
        : '当前无同时满足避风等级与水深的空闲泊位，请协调邻近渔港或锚泊避风';
    }

    const nextBerth: Berth = {
      ...berth,
      status: '占用',
      vesselId: vessel.id,
      vesselName: vessel.name,
      berthAt: berthAtIso,
      leaveAt: null,
      occupancyKind: '紧急',
      emergencyId: shelter.id,
      expiresAt: expiresAtIso,
      typhoonLevel: shelter.typhoonLevel,
    };

    await db.transaction('rw', db.berths, db.shelters, db.rerouteNotices, async () => {
      await db.shelters.put(toPlain(shelter));
      await db.berths.put(toPlain(nextBerth));
      if (notice) await db.rerouteNotices.put(toPlain(notice));
    });

    shelters.value = [...shelters.value, shelter];
    berths.value = berths.value.map((b) => (b.id === berth.id ? nextBerth : b));
    if (notice) rerouteNotices.value = [...rerouteNotices.value, notice];

    const message = displacedOrdinary
      ? `已紧急回港 ${port.name} ${berth.berthNo}，原普通船 ${displacedOrdinary.vesselName ?? '未知船舶'} 已被挤走`
      : `已紧急回港 ${port.name} ${berth.berthNo}，限时 ${hoursLabel(hours)}`;
    return { ok: true, shelter, displaced: Boolean(displacedOrdinary), suggestion: suggestionText, message };
  }

  /** 值班员为紧急船办理提前 / 正常离港 */
  async function completeShelter(shelterId: string): Promise<boolean> {
    const shelter = shelters.value.find((s) => s.id === shelterId);
    if (!shelter || shelter.status !== '有效') return false;
    const releasedAt = new Date().toISOString();
    const nextShelter: EmergencyShelter = { ...shelter, status: '已完成', releasedAt };
    await db.shelters.put(toPlain(nextShelter));
    shelters.value = shelters.value.map((s) => (s.id === shelterId ? nextShelter : s));
    await releaseBerthIfHeld(shelter, releasedAt);
    return true;
  }

  /**
   * 超时扫描：把已过 expiresAt 的有效紧急占用置为「已超时」并释放泊位，保留记录。
   * App 启动与定时任务都会调用；仅当泊位仍由该紧急船持有时才释放。
   * 并发调用复用同一次扫描。
   */
  let sweeping: Promise<number> | null = null;
  function sweepExpiredShelters(now: Date = new Date()): Promise<number> {
    if (sweeping) return sweeping;
    sweeping = (async () => {
      try {
        const due = shelters.value.filter(
          (s) => s.status === '有效' && new Date(s.expiresAt).getTime() <= now.getTime(),
        );
        if (!due.length) return 0;
        for (const shelter of due) {
          const releasedAt = shelter.expiresAt;
          const nextShelter: EmergencyShelter = { ...shelter, status: '已超时', releasedAt };
          await db.shelters.put(toPlain(nextShelter));
          shelters.value = shelters.value.map((s) => (s.id === shelter.id ? nextShelter : s));
          await releaseBerthIfHeld(shelter, releasedAt);
        }
        return due.length;
      } finally {
        sweeping = null;
      }
    })();
    return sweeping;
  }

  /** 释放仍持有该紧急占用的泊位（船已离开或被后续操作替换时不动） */
  async function releaseBerthIfHeld(shelter: EmergencyShelter, releasedAt: string): Promise<void> {
    const berth = berths.value.find((b) => b.portId === shelter.portId && b.berthNo === shelter.berthNo);
    if (!berth || berth.emergencyId !== shelter.id || berth.vesselId !== shelter.vesselId) return;
    const nextBerth: Berth = {
      ...berth,
      status: '空闲',
      vesselId: null,
      vesselName: null,
      berthAt: null,
      leaveAt: releasedAt,
      occupancyKind: undefined,
      emergencyId: null,
      expiresAt: null,
      typhoonLevel: null,
    };
    await db.berths.put(toPlain(nextBerth));
    berths.value = berths.value.map((b) => (b.id === berth.id ? nextBerth : b));
  }

  /** 标记改派提醒已处理 */
  async function handleNotice(noticeId: string, note = ''): Promise<void> {
    const hit = rerouteNotices.value.find((n) => n.id === noticeId);
    if (!hit || hit.handled) return;
    const next: RerouteNotice = { ...hit, handled: true, handleNote: note };
    await db.rerouteNotices.put(toPlain(next));
    rerouteNotices.value = rerouteNotices.value.map((n) => (n.id === noticeId ? next : n));
  }

  return {
    ports,
    berths,
    calls,
    shelters,
    rerouteNotices,
    loading,
    filter,
    filteredPorts,
    callsSorted,
    activeShelters,
    shelterHistory,
    pendingNotices,
    portById,
    berthsOf,
    callsOfVessel,
    activeShelterOfVessel,
    activeShelterOfBerth,
    sheltersOfVessel,
    shelterById,
    noticesOfVessel,
    resetFilter,
    loadAll,
    createPort,
    addBerth,
    setBerthStatus,
    updatePort,
    registerCall,
    requestEmergencyShelter,
    completeShelter,
    sweepExpiredShelters,
    handleNotice,
  };
});

function hoursLabel(hours: number): string {
  const h = Number(hours);
  if (h >= 24 && h % 24 === 0) return `${h / 24} 天`;
  return `${h} 小时`;
}
