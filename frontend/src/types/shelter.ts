/**
 * 台风紧急回港（限时避风占用）相关模型。
 *
 * 与普通进出港（PortCall / Berth.status === '占用'）的区别：
 * - 紧急回港允许证书过期的船进港，普通进港仍按证书拦截；
 * - 紧急占用是限时的（berthAt + durationHours），超时自动释放并保留记录；
 * - 无合适空闲泊位时，紧急船可以挤掉普通船（普通占用 berthAt 最早者优先），
 *   紧急船之间互不挤占；
 * - 同一泊位同一时段只有一条有效占用；同一艘船同时只能有一条有效紧急占用。
 */

/** 避风占用状态：有效（在港）/ 已完成（主动离港）/ 已超时（系统释放） */
export type ShelterStatus = '有效' | '已完成' | '已超时';

export const SHELTER_STATUSES: ShelterStatus[] = ['有效', '已完成', '已超时'];

/** 台风紧急回港限时占用记录 */
export interface EmergencyShelter {
  id: string;
  /** 避风渔港 id */
  portId: string;
  /** 渔港名（冗余，便于记录展示） */
  portName: string;
  /** 泊位号 */
  berthNo: string;
  /** 紧急回港渔船 id */
  vesselId: string;
  /** 渔船名（冗余） */
  vesselName: string;
  /** 台风等级（值班员填报） */
  typhoonLevel: number;
  /** 申请时渔港避风能力（级，冗余） */
  shelterLevel: number;
  /** 申请时泊位设计水深 m（冗余） */
  berthDepth: number;
  /** 渔船所需水深 m（按总吨位估算） */
  requiredDepth: number;
  /** 停留时长 h */
  durationHours: number;
  /** 靠泊时间（ISO 字符串） */
  berthAt: string;
  /** 预计释放时间（ISO 字符串）= berthAt + durationHours */
  expiresAt: string;
  /** 实际释放时间（ISO 字符串），未释放为 null */
  releasedAt: string | null;
  /** 被该紧急船挤走的原普通占用船 id（无挤占为 null） */
  displacedVesselId: string | null;
  /** 被挤走的原普通占用船名（冗余） */
  displacedVesselName: string | null;
  /** 状态：有效 / 已完成 / 已超时 */
  status: ShelterStatus;
  /** 备注（如重复提交时释放的该船原有普通占用） */
  remark: string;
  createdAt: string;
}

/** 被挤走普通船的改派提醒 */
export interface RerouteNotice {
  id: string;
  /** 被挤走的渔船 id */
  vesselId: string;
  /** 被挤走的渔船名（冗余） */
  vesselName: string;
  /** 原渔港 id */
  portId: string;
  /** 原渔港名（冗余） */
  portName: string;
  /** 原泊位号 */
  berthNo: string;
  /** 挤占它的紧急占用记录 id */
  shelterId: string;
  /** 挤占它的紧急船名 */
  emergencyVesselName: string;
  /** 台风等级 */
  typhoonLevel: number;
  /** 被挤走时间（ISO 字符串） */
  displacedAt: string;
  /** 改派建议渔港 id（无合适候选为 null） */
  suggestionPortId: string | null;
  /** 改派建议渔港名（冗余） */
  suggestionPortName: string | null;
  /** 改派建议泊位号 */
  suggestionBerthNo: string | null;
  /** 值班员是否已处理（标记已读） */
  handled: boolean;
  /** 处理备注 */
  handleNote: string;
  createdAt: string;
}

/** 紧急回港申请表单 */
export interface ShelterDraft {
  vesselId: string;
  portId: string;
  berthNo: string;
  typhoonLevel: number;
  durationHours: number;
}

export function emptyShelterDraft(): ShelterDraft {
  return {
    vesselId: '',
    portId: '',
    berthNo: '',
    typhoonLevel: 10,
    durationHours: 24,
  };
}

/** 可选停留时长 h */
export const SHELTER_DURATIONS: number[] = [6, 12, 24, 48, 72];
