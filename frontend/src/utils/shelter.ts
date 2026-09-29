/**
 * 台风紧急回港领域规则：吃水/水深估算、证书校验、避风等级匹配、挤占候选排序。
 * 全部为纯函数，便于在表单与 store 中复用。
 */
import type { FishingPort } from '../types/port';
import type { FishingVessel } from '../types/vessel';
import type { Berth } from '../types/berth';
import type { EmergencyShelter } from '../types/shelter';

/** 富余水深 m：泊位水深至少比渔船吃水深这么多 */
export const DEPTH_CLEARANCE = 0.5;

/**
 * 按总吨位估算设计吃水 m（沿海中小型渔船经验值，分段线性）。
 * <60t 约 2.2m；60-150t 约 2.2-3.2m；150-300t 约 3.2-4.2m；≥300t 每百吨加 0.3m。
 */
export function estimateDraftM(tonnage: number): number {
  const t = Number(tonnage) || 0;
  if (t <= 0) return 2.2;
  if (t < 60) return 2.2 + (t / 60) * 0; // 小型船统一 2.2 起步
  if (t < 150) return 2.2 + ((t - 60) / 90) * 1.0;
  if (t < 300) return 3.2 + ((t - 150) / 150) * 1.0;
  return 4.2 + ((t - 300) / 100) * 0.3;
}

/** 渔船安全靠泊所需最小水深 m（吃水 + 富余水深），只依赖总吨位 */
export function requiredDepthM(vessel: Pick<FishingVessel, 'grossTonnage'>): number {
  return Math.round((estimateDraftM(vessel.grossTonnage) + DEPTH_CLEARANCE) * 10) / 10;
}

/** 证书是否已过期（按当天 23:59:59 判断） */
export function isCertificateExpired(vessel: FishingVessel, now: Date = new Date()): boolean {
  const target = new Date(`${vessel.certificateExpiry}T23:59:59`);
  if (Number.isNaN(target.getTime())) return false;
  return target.getTime() < now.getTime();
}

/** 渔港避风能力能否扛住本次台风 */
export function portCanWithstand(port: FishingPort, typhoonLevel: number): boolean {
  return port.shelterLevel >= Number(typhoonLevel);
}

/** 泊位能否停靠该船：非维修且设计水深满足所需水深 */
export function berthDepthOk(berth: Berth, requiredDepth: number): boolean {
  return berth.status !== '维修' && Number(berth.designDepth) >= Number(requiredDepth);
}

export interface BerthCandidate {
  berth: Berth;
  /** 普通占用船（可被挤掉）；空闲泊位为 null */
  occupant: Berth | null;
}

/**
 * 选定渔港内的候选泊位排位（值班员选好渔港后按此排位，也用于自动推荐）：
 * 1. 水深满足的空闲泊位优先，按水深从浅到深（浅水优先，留深水给大船）；
 * 2. 其次是水深满足、普通占用的泊位（可挤掉），按靠泊时间从早到晚（先到先被挤）；
 * 3. 紧急占用与维修泊位不可选。
 */
export function rankBerthCandidates(berths: Berth[], requiredDepth: number): BerthCandidate[] {
  const usable = berths.filter(
    (b) => b.status !== '维修' && Number(b.designDepth) >= Number(requiredDepth) && b.occupancyKind !== '紧急',
  );
  const free = usable
    .filter((b) => b.status === '空闲')
    .sort((a, b) => a.designDepth - b.designDepth || a.berthNo.localeCompare(b.berthNo));
  const ordinaryOccupied = usable
    .filter((b) => b.status === '占用' && b.occupancyKind !== '紧急')
    .sort((a, b) => (a.berthAt ?? '').localeCompare(b.berthAt ?? '') || a.berthNo.localeCompare(b.berthNo));
  return [
    ...free.map((berth) => ({ berth, occupant: null })),
    ...ordinaryOccupied.map((berth) => ({ berth, occupant: berth })),
  ];
}

/** 找一个水深满足的空闲泊位（用于改派建议），不满足返回 null */
export function findFreeBerth(berths: Berth[], requiredDepth: number): Berth | null {
  const hit = berths
    .filter((b) => b.status === '空闲' && Number(b.designDepth) >= Number(requiredDepth))
    .sort((a, b) => a.designDepth - b.designDepth || a.berthNo.localeCompare(b.berthNo))[0];
  return hit ?? null;
}

/**
 * 改派建议渔港：能扛住本次台风、水深满足、且有空闲泊位的其他渔港；
 * 优先避风能力刚好满足的渔港，其次空闲泊位更多。
 */
export function suggestReroutePort(
  ports: FishingPort[],
  berthsByPort: (portId: string) => Berth[],
  requiredDepth: number,
  typhoonLevel: number,
  excludePortId: string,
): { port: FishingPort; berth: Berth } | null {
  const options: Array<{ port: FishingPort; berth: Berth; freeCount: number }> = [];
  for (const port of ports) {
    if (port.id === excludePortId) continue;
    if (!portCanWithstand(port, typhoonLevel)) continue;
    const list = berthsByPort(port.id);
    const berth = findFreeBerth(list, requiredDepth);
    if (!berth) continue;
    options.push({ port, berth, freeCount: list.filter((b) => b.status === '空闲').length });
  }
  options.sort(
    (a, b) =>
      a.port.shelterLevel - b.port.shelterLevel ||
      b.freeCount - a.freeCount ||
      a.port.name.localeCompare(b.port.name),
  );
  return options[0] ? { port: options[0].port, berth: options[0].berth } : null;
}

/** 紧急占用是否仍在限时内 */
export function isShelterActive(shelter: EmergencyShelter, now: Date = new Date()): boolean {
  return shelter.status === '有效' && new Date(shelter.expiresAt).getTime() > now.getTime();
}

/** 紧急占用剩余分钟数（已超时为 0 或负数） */
export function remainingMinutes(shelter: EmergencyShelter, now: Date = new Date()): number {
  return Math.floor((new Date(shelter.expiresAt).getTime() - now.getTime()) / 60000);
}
