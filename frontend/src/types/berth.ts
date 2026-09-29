/** 泊位状态 */
export type BerthStatus = '空闲' | '占用' | '维修';

export const BERTH_STATUSES: BerthStatus[] = ['空闲', '占用', '维修'];

/** 占用性质：普通进港 / 紧急回港限时占用 */
export type OccupyKind = '普通' | '紧急';

export const OCCUPY_KINDS: OccupyKind[] = ['普通', '紧急'];

/** 泊位占用记录 */
export interface Berth {
  id: string;
  /** 所属渔港 id */
  portId: string;
  /** 泊位号 */
  berthNo: string;
  /** 占用渔船 id */
  vesselId: string | null;
  /** 占用渔船名 */
  vesselName: string | null;
  /** 靠泊时间（ISO 字符串） */
  berthAt: string | null;
  /** 离泊时间（ISO 字符串） */
  leaveAt: string | null;
  /** 状态：空闲 / 占用 / 维修 */
  status: BerthStatus;
  /** 泊位设计水深 m */
  designDepth: number;
  /** 占用性质：普通进港 / 紧急回港（v4 起） */
  occupyKind?: OccupyKind;
  /** 紧急占用到期时间（ISO 字符串），仅 occupyKind=紧急 时有值 */
  expireAt?: string | null;
  /** 关联的紧急占用记录 id，仅 occupyKind=紧急 时有值 */
  emergencyStayId?: string | null;
}

/** 泊位占用聚合结果（useBerthStatus 输出） */
export interface BerthSummary {
  portId: string;
  total: number;
  occupied: number;
  free: number;
  maintenance: number;
  /** 紧急限时占用数量 */
  emergency: number;
  /** 占用率 0-1 */
  occupancyRate: number;
  /** 在港船舶数量 */
  inPortCount: number;
  freeBerths: Berth[];
  occupiedBerths: Berth[];
  emergencyBerths: Berth[];
}
