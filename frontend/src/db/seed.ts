import type { FishingPort } from '../types/port';
import type { FishingVessel } from '../types/vessel';
import type { PortCall } from '../types/call';
import type { EmergencyStay, ReassignmentNotice } from '../types/emergency';
import { toPlain } from '../utils/format';
import { db } from './index';
import { buildBerthRecords } from './berth';

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

/** 初始渔港 */
export const SEED_PORTS: FishingPort[] = [
  {
    id: 'p-1001',
    name: '石浦中心渔港',
    level: '中心渔港',
    longitude: 121.9437,
    latitude: 29.2119,
    berthCount: 6,
    berthDepth: 5.5,
    wharfLength: 420,
    shelterLevel: 12,
    supply: { fuel: true, ice: true, water: true },
    manager: '象山县渔港管理站',
    createdAt: daysAgo(420),
  },
  {
    id: 'p-1002',
    name: '沈家门中心渔港',
    level: '中心渔港',
    longitude: 122.2979,
    latitude: 29.9447,
    berthCount: 8,
    berthDepth: 6.2,
    wharfLength: 680,
    shelterLevel: 11,
    supply: { fuel: true, ice: true, water: false },
    manager: '普陀区渔港服务中心',
    createdAt: daysAgo(365),
  },
  {
    id: 'p-1003',
    name: '岱山高亭渔港',
    level: '一级渔港',
    longitude: 122.2031,
    latitude: 30.2567,
    berthCount: 5,
    berthDepth: 4.8,
    wharfLength: 300,
    shelterLevel: 10,
    supply: { fuel: false, ice: true, water: true },
    manager: '岱山县渔业合作社',
    createdAt: daysAgo(280),
  },
  {
    id: 'p-1004',
    name: '温岭石塘渔港',
    level: '二级渔港',
    longitude: 121.6612,
    latitude: 28.3407,
    berthCount: 4,
    berthDepth: 3.9,
    wharfLength: 210,
    shelterLevel: 9,
    supply: { fuel: false, ice: false, water: true },
    manager: '温岭市石塘镇渔业服务站',
    createdAt: daysAgo(150),
  },
];

/** 初始渔船档案 */
export const SEED_VESSELS: FishingVessel[] = [
  {
    id: 'v-2001',
    name: '浙象渔05123',
    vesselNo: 'ZXY05123',
    homePort: '石浦',
    length: 32.5,
    beam: 6.4,
    grossTonnage: 168,
    enginePower: 268,
    operationType: '拖网',
    hullMaterial: '钢质',
    owner: '林海平',
    certificateExpiry: '2027-06-30',
    createdAt: daysAgo(300),
  },
  {
    id: 'v-2002',
    name: '浙普渔13208',
    vesselNo: 'ZPY13208',
    homePort: '沈家门',
    length: 28.6,
    beam: 5.8,
    grossTonnage: 120,
    enginePower: 202,
    operationType: '围网',
    hullMaterial: '钢质',
    owner: '王阿明',
    certificateExpiry: '2026-11-15',
    createdAt: daysAgo(260),
  },
  {
    id: 'v-2003',
    name: '浙岱渔07156',
    vesselNo: 'ZDY07156',
    homePort: '高亭',
    length: 24.2,
    beam: 5.1,
    grossTonnage: 88,
    enginePower: 158,
    operationType: '刺网',
    hullMaterial: '木质',
    owner: '郑友良',
    certificateExpiry: '2026-02-28',
    createdAt: daysAgo(210),
  },
  {
    id: 'v-2004',
    name: '浙岭渔09342',
    vesselNo: 'ZLY09342',
    homePort: '石塘',
    length: 19.8,
    beam: 4.6,
    grossTonnage: 56,
    enginePower: 96,
    operationType: '钓具',
    hullMaterial: '玻璃钢',
    owner: '陈小军',
    certificateExpiry: '2027-03-20',
    createdAt: daysAgo(180),
  },
  {
    id: 'v-2005',
    name: '浙象渔05288',
    vesselNo: 'ZXY05288',
    homePort: '石浦',
    length: 35.0,
    beam: 6.8,
    grossTonnage: 196,
    enginePower: 330,
    operationType: '拖网',
    hullMaterial: '钢质',
    owner: '张卫国',
    certificateExpiry: '2028-01-10',
    createdAt: daysAgo(120),
  },
  {
    id: 'v-2006',
    name: '浙普渔13566',
    vesselNo: 'ZPY13566',
    homePort: '沈家门',
    length: 21.5,
    beam: 4.9,
    grossTonnage: 72,
    enginePower: 132,
    operationType: '围网',
    hullMaterial: '铝合金',
    owner: '刘建军',
    certificateExpiry: '2026-08-05',
    createdAt: daysAgo(90),
  },
  {
    id: 'v-2007',
    name: '浙象渔05999',
    vesselNo: 'ZXY05999',
    homePort: '石浦',
    length: 26.8,
    beam: 5.6,
    grossTonnage: 105,
    enginePower: 184,
    operationType: '刺网',
    hullMaterial: '钢质',
    owner: '黄阿康',
    certificateExpiry: '2026-04-15',
    createdAt: daysAgo(70),
  },
  {
    id: 'v-2008',
    name: '浙象渔05777',
    vesselNo: 'ZXY05777',
    homePort: '石浦',
    length: 30.2,
    beam: 6.1,
    grossTonnage: 142,
    enginePower: 226,
    operationType: '拖网',
    hullMaterial: '钢质',
    owner: '吴海涛',
    certificateExpiry: '2026-05-10',
    createdAt: daysAgo(60),
  },
  {
    id: 'v-2009',
    name: '浙奉渔08118',
    vesselNo: 'ZFY08118',
    homePort: '石浦',
    length: 25.4,
    beam: 5.4,
    grossTonnage: 96,
    enginePower: 171,
    operationType: '钓具',
    hullMaterial: '钢质',
    owner: '沈志国',
    certificateExpiry: '2027-09-01',
    createdAt: daysAgo(40),
  },
];

/** 初始进出港流水 */
export const SEED_CALLS: PortCall[] = [
  {
    id: 'c-3001',
    vesselId: 'v-2001',
    vesselName: '浙象渔05123',
    type: '进港',
    time: hoursAgo(5),
    berthNo: 'B01',
    iceKg: 1200,
    fuelL: 800,
    unloadKg: 8600,
    visaStatus: '已签证',
    createdAt: hoursAgo(5),
  },
  {
    id: 'c-3002',
    vesselId: 'v-2005',
    vesselName: '浙象渔05288',
    type: '进港',
    time: hoursAgo(3),
    berthNo: 'B02',
    iceKg: 900,
    fuelL: 1200,
    unloadKg: 12400,
    visaStatus: '已签证',
    createdAt: hoursAgo(3),
  },
  {
    id: 'c-3003',
    vesselId: 'v-2002',
    vesselName: '浙普渔13208',
    type: '进港',
    time: hoursAgo(2),
    berthNo: 'B01',
    iceKg: 600,
    fuelL: 0,
    unloadKg: 5200,
    visaStatus: '待签证',
    createdAt: hoursAgo(2),
  },
  {
    id: 'c-3004',
    vesselId: 'v-2003',
    vesselName: '浙岱渔07156',
    type: '进港',
    time: hoursAgo(1),
    berthNo: 'B01',
    iceKg: 300,
    fuelL: 260,
    unloadKg: 2100,
    visaStatus: '免签',
    createdAt: hoursAgo(1),
  },
  {
    id: 'c-3005',
    vesselId: 'v-2004',
    vesselName: '浙岭渔09342',
    type: '出港',
    time: daysAgo(1),
    berthNo: 'B02',
    iceKg: 0,
    fuelL: 420,
    unloadKg: 0,
    visaStatus: '已签证',
    createdAt: daysAgo(1),
  },
  {
    id: 'c-3006',
    vesselId: 'v-2006',
    vesselName: '浙普渔13566',
    type: '进港',
    time: daysAgo(1),
    berthNo: 'B02',
    iceKg: 480,
    fuelL: 300,
    unloadKg: 3600,
    visaStatus: '已签证',
    createdAt: daysAgo(1),
  },
  {
    id: 'c-3009',
    vesselId: 'v-2009',
    vesselName: '浙奉渔08118',
    type: '进港',
    time: hoursAgo(1),
    berthNo: 'B06',
    iceKg: 200,
    fuelL: 180,
    unloadKg: 1500,
    visaStatus: '待签证',
    createdAt: hoursAgo(1),
  },
  {
    id: 'c-3007',
    vesselId: 'v-2001',
    vesselName: '浙象渔05123',
    type: '出港',
    time: daysAgo(2),
    berthNo: 'B01',
    iceKg: 0,
    fuelL: 950,
    unloadKg: 0,
    visaStatus: '已签证',
    createdAt: daysAgo(2),
  },
  {
    id: 'c-3008',
    vesselId: 'v-2002',
    vesselName: '浙普渔13208',
    type: '出港',
    time: daysAgo(4),
    berthNo: 'B03',
    iceKg: 200,
    fuelL: 540,
    unloadKg: 0,
    visaStatus: '待签证',
    createdAt: daysAgo(4),
  },
];

/** 预置一条生效中的紧急限时占用：v-2008（证书过期）挤掉排位最末普通船 v-2009，4 小时后到期 */
const SEED_EMERGENCY_STAYS: EmergencyStay[] = [
  {
    id: 'e-seed-4001',
    vesselId: 'v-2008',
    vesselName: '浙象渔05777',
    portId: 'p-1001',
    portName: '石浦中心渔港',
    berthId: 'p-1001-B06',
    berthNo: 'B06',
    typhoonLevel: 12,
    vesselDraft: 3.6,
    durationHours: 6,
    startAt: hoursAgo(2),
    expireAt: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
    status: '生效中',
    releasedAt: null,
    releaseReason: null,
    certificateExpired: true,
    displacedVesselId: 'v-2009',
    displacedVesselName: '浙奉渔08118',
    displacedAt: hoursAgo(2),
    createdAt: hoursAgo(2),
  },
];

const SEED_REASSIGN_NOTICES: ReassignmentNotice[] = [
  {
    id: 'n-seed-5001',
    stayId: 'e-seed-4001',
    vesselId: 'v-2009',
    vesselName: '浙奉渔08118',
    portId: 'p-1001',
    portName: '石浦中心渔港',
    berthNo: 'B06',
    displacedAt: hoursAgo(2),
    suggestion:
      '浙奉渔08118：原 石浦中心渔港 B06 泊位已让给 12 级台风紧急避险船浙象渔05777，请凭本提醒改派其他空闲泊位或前往避风等级适配的邻近渔港',
    read: false,
    createdAt: hoursAgo(2),
  },
];

/**
 * 首次进入时写入演示数据，并为缺少泊位记录的渔港补齐泊位。
 * 写库前统一 toPlain 脱代理，避免 DataCloneError。
 * 全程幂等：已存在的库 / 泊位 / 紧急占用均不重复写入。
 */
export async function ensureSeedData(): Promise<void> {
  const portCount = await db.ports.count();
  if (portCount === 0) {
    await db.ports.bulkPut(toPlain(SEED_PORTS));
    await db.vessels.bulkPut(toPlain(SEED_VESSELS));
    await db.calls.bulkPut(toPlain(SEED_CALLS));
  }
  const ports = await db.ports.toArray();
  for (const port of ports) {
    const existing = await db.berths.where('portId').equals(port.id).count();
    if (existing === 0) {
      await db.berths.bulkPut(toPlain(buildBerthRecords(port)));
    }
  }
  // 预置紧急占用：仅在无任何紧急记录时播种，泊位 B06 同步为紧急限时状态
  if ((await db.emergencyStays.count()) === 0 && (await db.ports.get('p-1001'))) {
    await db.emergencyStays.bulkPut(toPlain(SEED_EMERGENCY_STAYS));
    await db.reassignNotices.bulkPut(toPlain(SEED_REASSIGN_NOTICES));
    const berth = await db.berths.get('p-1001-B06');
    const stay = SEED_EMERGENCY_STAYS[0];
    if (berth) {
      await db.berths.put(
        toPlain({
          ...berth,
          status: '占用',
          vesselId: stay.vesselId,
          vesselName: stay.vesselName,
          berthAt: stay.startAt,
          leaveAt: null,
          occupyKind: '紧急',
          expireAt: stay.expireAt,
          emergencyStayId: stay.id,
        }),
      );
    }
  }
}
