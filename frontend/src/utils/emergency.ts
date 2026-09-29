/**
 * 紧急回港排位规则（纯函数，便于单测与界面复用）：
 * 1. 渔港避风能力必须 ≥ 申报台风等级，否则不予安排；
 * 2. 泊位水深必须 ≥ 船舶吃水，维修泊位不参与；
 * 3. 优先用空闲泊位（水深适配中取最贴近吃水的，保留深水泊位给大船）；
 * 4. 无空闲时挤掉「普通」占用船：按现有占用排位，后到者（靠泊时间最晚）排位最末先被挤；
 *    紧急限时占用之间不可互相挤用；
 * 5. 既无空闲又无普通船可挤 → 该港无法接纳。
 */
import type { Berth } from '../types/berth';
import type { FishingPort } from '../types/port';
import type { FishingVessel } from '../types/vessel';

export interface EmergencyBerthPick {
  berth: Berth;
  /** 被挤走的普通船占用信息；空闲泊位时为 null */
  displaced: { vesselId: string; vesselName: string; berthAt: string } | null;
}

export interface EmergencyPortRank {
  port: FishingPort;
  /** 水深适配的空闲泊位数 */
  freeCount: number;
  /** 可被挤走的普通船数 */
  bumpableCount: number;
  /** 该港可用泊位最大水深 */
  maxDepth: number;
  /** 是否可立即接纳（有空闲或有可挤普通船） */
  available: boolean;
}

/** 证书是否已过期（含当天到期之后才算有效） */
export function isCertificateExpired(vessel: FishingVessel, now: Date = new Date()): boolean {
  return daysUntilExpiryAt(vessel.certificateExpiry, now) < 0;
}

function daysUntilExpiryAt(expiry: string, now: Date): number {
  const target = new Date(`${expiry}T23:59:59`);
  if (Number.isNaN(target.getTime())) return Number.NaN;
  return Math.ceil((target.getTime() - now.getTime()) / (24 * 3600 * 1000));
}

/** 由船长估算满载吃水 m（无吃水档案时的默认值，值班员可在表单调整） */
export function estimateDraft(vessel: FishingVessel): number {
  return Number((vessel.length * 0.12).toFixed(1));
}

/** 该渔港是否扛得住申报的台风等级 */
export function shelterMatches(port: FishingPort, typhoonLevel: number): boolean {
  return port.shelterLevel >= Number(typhoonLevel);
}

/** 该泊位能否容纳指定吃水的船 */
export function depthMatches(berth: Berth, draft: number): boolean {
  return berth.designDepth >= Number(draft);
}

/**
 * 在指定渔港内挑一个紧急泊位。
 */
export function pickEmergencyBerth(
  port: FishingPort,
  berths: Berth[],
  draft: number,
  typhoonLevel: number,
): EmergencyBerthPick | null {
  if (!shelterMatches(port, typhoonLevel)) return null;

  const usable = berths.filter(
    (b) => b.portId === port.id && b.status !== '维修' && depthMatches(b, draft),
  );

  // 1) 空闲泊位：取水深最贴近吃水者（先保大船用的深水泊位），同水深按泊位号
  const free = usable
    .filter((b) => b.status === '空闲')
    .sort((a, b) => a.designDepth - b.designDepth || a.berthNo.localeCompare(b.berthNo));
  if (free.length) return { berth: free[0], displaced: null };

  // 2) 挤掉普通船：紧急船不互挤；排位最末（最晚靠泊）的普通船先被挤
  const bumpable = usable
    .filter((b) => b.status === '占用' && b.occupyKind !== '紧急' && b.vesselId)
    .sort(
      (a, b) =>
        new Date(b.berthAt ?? 0).getTime() - new Date(a.berthAt ?? 0).getTime() ||
        a.berthNo.localeCompare(b.berthNo),
    );
  if (bumpable.length) {
    const target = bumpable[0];
    return {
      berth: target,
      displaced: {
        vesselId: target.vesselId as string,
        vesselName: target.vesselName as string,
        berthAt: target.berthAt as string,
      },
    };
  }
  return null;
}

/**
 * 渔港排位：避风等级达标前提下，能立即接纳的优先；
 * 同等条件避风能力更强、水深更深、现有占用更松的港排在前面。
 */
export function rankPortsForEmergency(
  ports: FishingPort[],
  berths: Berth[],
  draft: number,
  typhoonLevel: number,
): EmergencyPortRank[] {
  return ports
    .filter((p) => shelterMatches(p, typhoonLevel))
    .map((port) => {
      const mine = berths.filter((b) => b.portId === port.id && b.status !== '维修');
      const deepEnough = mine.filter((b) => depthMatches(b, draft));
      const freeCount = deepEnough.filter((b) => b.status === '空闲').length;
      const bumpableCount = deepEnough.filter(
        (b) => b.status === '占用' && b.occupyKind !== '紧急' && b.vesselId,
      ).length;
      return {
        port,
        freeCount,
        bumpableCount,
        maxDepth: deepEnough.length ? Math.max(...deepEnough.map((b) => b.designDepth)) : 0,
        available: freeCount + bumpableCount > 0,
      };
    })
    .sort((a, b) => {
      if (Number(a.available) !== Number(b.available)) return a.available ? -1 : 1;
      const slackA = a.freeCount * 2 + a.bumpableCount;
      const slackB = b.freeCount * 2 + b.bumpableCount;
      if (slackA !== slackB) return slackB - slackA;
      if (a.port.shelterLevel !== b.port.shelterLevel) return b.port.shelterLevel - a.port.shelterLevel;
      return b.maxDepth - a.maxDepth;
    });
}
