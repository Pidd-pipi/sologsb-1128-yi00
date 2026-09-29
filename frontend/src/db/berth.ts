import type { FishingPort } from '../types/port';
import type { Berth, BerthStatus } from '../types/berth';
import type { EmergencyShelter, RerouteNotice } from '../types/shelter';
import { requiredDepthM } from '../utils/shelter';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

/** 紧急演示数据所需渔船的最小档案（与 seed.ts 中同 id 记录保持一致，避免模块循环依赖） */
const EMERGENCY_VESSEL_MIN = { id: 'v-2003', name: '浙岱渔07156', grossTonnage: 88 };
const DISPLACED_VESSEL_MIN = { id: 'v-2006', name: '浙普渔13566', grossTonnage: 72 };
const HISTORY_VESSEL_MIN = { id: 'v-2004', name: '浙岭渔09342', grossTonnage: 56 };

export interface SeedOccupancy {
  berthNo: string;
  vesselId: string;
  vesselName: string;
  status: BerthStatus;
  berthAt: string;
}

/** 演示数据中的初始占用 / 维修泊位 */
export const SEED_OCCUPANCY: Record<string, SeedOccupancy[]> = {
  'p-1001': [
    { berthNo: 'B01', vesselId: 'v-2001', vesselName: '浙象渔05123', status: '占用', berthAt: hoursAgo(5) },
    { berthNo: 'B02', vesselId: 'v-2005', vesselName: '浙象渔05288', status: '占用', berthAt: hoursAgo(3) },
    { berthNo: 'B04', vesselId: '', vesselName: '', status: '维修', berthAt: '' },
  ],
  'p-1002': [
    { berthNo: 'B01', vesselId: 'v-2002', vesselName: '浙普渔13208', status: '占用', berthAt: hoursAgo(2) },
    { berthNo: 'B02', vesselId: 'v-2006', vesselName: '浙普渔13566', status: '占用', berthAt: hoursAgo(26) },
    { berthNo: 'B06', vesselId: '', vesselName: '', status: '维修', berthAt: '' },
  ],
  'p-1003': [
    { berthNo: 'B01', vesselId: 'v-2003', vesselName: '浙岱渔07156', status: '占用', berthAt: hoursAgo(1) },
  ],
  'p-1004': [],
};

/**
 * 演示数据中的一条生效中台风紧急避风占用：
 * 证书已过期的「浙岱渔07156」在沈家门中心渔港 B02 紧急避风，挤掉了普通船「浙普渔13566」。
 * 时间相对当前时刻生成，保证首次打开时仍在限时内。
 */
const EMERGENCY_PORT_ID = 'p-1002';
const EMERGENCY_BERTH_NO = 'B02';

/** 生效中：沈家门避风 11 级扛 11 级台风，靠泊 2 小时，限时 24 小时（还剩约 22 小时） */
export const SEED_SHELTER_ACTIVE: EmergencyShelter = {
  id: 'e-4001',
  portId: EMERGENCY_PORT_ID,
  portName: '沈家门中心渔港',
  berthNo: EMERGENCY_BERTH_NO,
  vesselId: EMERGENCY_VESSEL_MIN.id,
  vesselName: EMERGENCY_VESSEL_MIN.name,
  typhoonLevel: 11,
  shelterLevel: 11,
  berthDepth: 6.2,
  requiredDepth: requiredDepthM(EMERGENCY_VESSEL_MIN),
  durationHours: 24,
  berthAt: hoursAgo(2),
  expiresAt: hoursFromNow(22),
  releasedAt: null,
  displacedVesselId: DISPLACED_VESSEL_MIN.id,
  displacedVesselName: DISPLACED_VESSEL_MIN.name,
  status: '有效',
  remark: '',
  createdAt: hoursAgo(2),
};

/** 被挤走船的改派提醒：石浦中心渔港 B03 当时空闲且水深满足 */
export const SEED_REROUTE_NOTICE: RerouteNotice = {
  id: 'n-5001',
  vesselId: DISPLACED_VESSEL_MIN.id,
  vesselName: DISPLACED_VESSEL_MIN.name,
  portId: EMERGENCY_PORT_ID,
  portName: '沈家门中心渔港',
  berthNo: EMERGENCY_BERTH_NO,
  shelterId: SEED_SHELTER_ACTIVE.id,
  emergencyVesselName: EMERGENCY_VESSEL_MIN.name,
  typhoonLevel: 11,
  displacedAt: hoursAgo(2),
  suggestionPortId: 'p-1001',
  suggestionPortName: '石浦中心渔港',
  suggestionBerthNo: 'B03',
  handled: false,
  handleNote: '',
  createdAt: hoursAgo(2),
};

/** 一条已超时释放的历史紧急回港记录（释放后保留记录的演示） */
export const SEED_SHELTER_HISTORY: EmergencyShelter = {
  id: 'e-4002',
  portId: 'p-1004',
  portName: '温岭石塘渔港',
  berthNo: 'B01',
  vesselId: HISTORY_VESSEL_MIN.id,
  vesselName: HISTORY_VESSEL_MIN.name,
  typhoonLevel: 9,
  shelterLevel: 9,
  berthDepth: 3.9,
  requiredDepth: requiredDepthM(HISTORY_VESSEL_MIN),
  durationHours: 12,
  berthAt: hoursAgo(50),
  expiresAt: hoursAgo(38),
  releasedAt: hoursAgo(38),
  displacedVesselId: null,
  displacedVesselName: null,
  status: '已超时',
  remark: '',
  createdAt: hoursAgo(50),
};

/** 初始泊位中的紧急覆盖（覆盖 SEED_OCCUPANCY 中同泊位的普通占用） */
export const SEED_EMERGENCY_OVERRIDES: Record<string, Record<string, EmergencyShelter>> = {
  [EMERGENCY_PORT_ID]: { [EMERGENCY_BERTH_NO]: SEED_SHELTER_ACTIVE },
};

/**
 * 按渔港登记的泊位数生成泊位记录（初始播种与 Dexie v3 迁移共用）。
 */
export function buildBerthRecords(
  port: FishingPort,
  occupancy: SeedOccupancy[] = SEED_OCCUPANCY[port.id] ?? [],
): Berth[] {
  const emergencyByBerth = SEED_EMERGENCY_OVERRIDES[port.id] ?? {};
  const records: Berth[] = [];
  for (let i = 1; i <= port.berthCount; i++) {
    const berthNo = `B${pad2(i)}`;
    const hit = occupancy.find((o) => o.berthNo === berthNo);
    const emergency = emergencyByBerth[berthNo];
    const occupied = Boolean(emergency) || (hit && hit.status === '占用');
    records.push({
      id: `${port.id}-${berthNo}`,
      portId: port.id,
      berthNo,
      vesselId: emergency ? emergency.vesselId : occupied ? hit!.vesselId : null,
      vesselName: emergency ? emergency.vesselName : occupied ? hit!.vesselName : null,
      berthAt: emergency ? emergency.berthAt : occupied ? hit!.berthAt : null,
      leaveAt: null,
      status: occupied ? '占用' : hit ? hit.status : '空闲',
      designDepth: port.berthDepth,
      occupancyKind: emergency ? '紧急' : occupied ? '普通' : undefined,
      emergencyId: emergency ? emergency.id : null,
      expiresAt: emergency ? emergency.expiresAt : null,
      typhoonLevel: emergency ? emergency.typhoonLevel : null,
    });
  }
  return records;
}
