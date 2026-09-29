import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { db } from '../db';
import { toPlain, uid } from '../utils/format';
import { emptyPortFilter, type FishingPort, type PortFilter, type SupplyCapability } from '../types/port';
import type { Berth, BerthStatus } from '../types/berth';
import type { CallDraft, PortCall } from '../types/call';
import { useVesselStore } from './vesselStore';
import { isCertificateExpired } from '../utils/emergency';
import { buildBerthRecords } from '../db/berth';

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

export const usePortStore = defineStore('port', () => {
  const ports = ref<FishingPort[]>([]);
  const berths = ref<Berth[]>([]);
  const calls = ref<PortCall[]>([]);
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

  function portById(id: string): FishingPort | undefined {
    return ports.value.find((p) => p.id === id);
  }

  function berthsOf(portId: string): Berth[] {
    return berths.value.filter((b) => b.portId === portId).sort((a, b) => a.berthNo.localeCompare(b.berthNo));
  }

  function callsOfVessel(vesselId: string): PortCall[] {
    return callsSorted.value.filter((c) => c.vesselId === vesselId);
  }

  function resetFilter(): void {
    filter.value = emptyPortFilter();
  }

  async function loadAll(): Promise<void> {
    loading.value = true;
    try {
      const [p, b, c] = await Promise.all([db.ports.toArray(), db.berths.toArray(), db.calls.toArray()]);
      ports.value = p;
      berths.value = b;
      calls.value = c;
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
      occupyKind: status === '占用' ? hit.occupyKind ?? '普通' : '普通',
      expireAt: status === '空闲' ? null : hit.expireAt ?? null,
      emergencyStayId: status === '空闲' ? null : hit.emergencyStayId ?? null,
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

  /** 直接落库一条泊位状态（紧急回港事务提交后复用，保证 berths 与 store 一致） */
  async function syncBerthFromDb(berthId: string): Promise<void> {
    const fresh = await db.berths.get(berthId);
    if (!fresh) return;
    const exists = berths.value.some((b) => b.id === fresh.id);
    berths.value = exists
      ? berths.value.map((b) => (b.id === fresh.id ? fresh : b))
      : [...berths.value, fresh];
  }

  /**
   * 登记一条进出港记录，并同步泊位占用状态（进港 → 占用，出港 → 释放）。
   * 普通进港拦截规则：证书过期船只不得普通进港（紧急回港请走台风避险通道）；
   * 同一泊位同一时段只能有一条有效占用；同一艘船已有在港占用时不得重复进港。
   */
  async function registerCall(draft: CallDraft, vesselName: string, portId: string): Promise<PortCall> {
    const vesselStore = useVesselStore();
    const vessel = vesselStore.vesselById(draft.vesselId);

    if (draft.type === '进港') {
      if (vessel && isCertificateExpired(vessel)) {
        throw new Error(`该船证书已于 ${vessel.certificateExpiry} 过期，普通进港不予签证，请改走台风紧急回港`);
      }
      // 同一泊位同一时段只留一条有效占用
      const berth = berths.value.find((b) => b.portId === portId && b.berthNo === draft.berthNo);
      if (berth && berth.status === '占用') {
        throw new Error(
          `${berth.berthNo} 已被${berth.occupyKind === '紧急' ? '紧急回港船 ' : ''}${berth.vesselName ?? '其他船舶'}占用，同一泊位同一时段只留一条有效占用`,
        );
      }
      // 同一艘船重复提交不能多占（任意渔港已有有效占用即拦截）
      const occupied = await db.berths.where('vesselId').equals(draft.vesselId).filter((b) => b.status === '占用').first();
      if (occupied) {
        const otherPort = portById(occupied.portId)?.name ?? occupied.portId;
        throw new Error(`${vesselName} 已在 ${otherPort} ${occupied.berthNo} 泊位占用中，同一艘船不能重复进港多占`);
      }
    } else {
      // 出港必须是本船当前占用的泊位；紧急限时占用请到台风避险通道办理释放
      const berth = berths.value.find((b) => b.portId === portId && b.berthNo === draft.berthNo);
      if (!berth || berth.status !== '占用') {
        throw new Error(`${draft.berthNo} 当前并非占用状态，无法办理出港`);
      }
      if (berth.vesselId !== draft.vesselId) {
        throw new Error(`${draft.berthNo} 当前由 ${berth.vesselName ?? '其他船舶'} 占用，不能替别的船办理出港`);
      }
      if (berth.occupyKind === '紧急') {
        throw new Error('紧急限时占用不能直接普通出港，请到台风避险通道办理释放');
      }
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

    const berth = berths.value.find((b) => b.portId === portId && b.berthNo === draft.berthNo);
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
              occupyKind: '普通',
              expireAt: null,
              emergencyStayId: null,
            }
          : {
              ...berth,
              status: '空闲',
              vesselId: null,
              vesselName: null,
              berthAt: null,
              leaveAt: call.time,
              occupyKind: '普通',
              expireAt: null,
              emergencyStayId: null,
            };
      await db.berths.put(toPlain(next));
      berths.value = berths.value.map((b) => (b.id === berth.id ? next : b));
    }
    return call;
  }

  return {
    ports,
    berths,
    calls,
    loading,
    filter,
    filteredPorts,
    callsSorted,
    portById,
    berthsOf,
    callsOfVessel,
    resetFilter,
    loadAll,
    createPort,
    addBerth,
    setBerthStatus,
    syncBerthFromDb,
    updatePort,
    registerCall,
  };
});
