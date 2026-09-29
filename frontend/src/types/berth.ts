/** 泊位状态 */
export type BerthStatus = '空闲' | '占用' | '维修';

export const BERTH_STATUSES: BerthStatus[] = ['空闲', '占用', '维修'];

/** 占用类型：普通进出港占用 / 台风紧急避风占用 */
export type BerthOccupancyKind = '普通' | '紧急';

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
  /** 占用类型：普通进出港 / 台风紧急避风（v4 起紧急占用写入） */
  occupancyKind?: BerthOccupancyKind;
  /** 紧急占用记录 id（occupancyKind === '紧急' 时存在） */
  emergencyId?: string | null;
  /** 紧急占用预计释放时间（ISO 字符串） */
  expiresAt?: string | null;
  /** 紧急占用申报的台风等级 */
  typhoonLevel?: number | null;
}

/** 泊位占用聚合结果（useBerthStatus 输出） */
export interface BerthSummary {
  portId: string;
  total: number;
  occupied: number;
  free: number;
  maintenance: number;
  /** 占用率 0-1 */
  occupancyRate: number;
  /** 在港船舶数量 */
  inPortCount: number;
  /** 其中台风紧急避风占用数 */
  emergencyCount: number;
  freeBerths: Berth[];
  occupiedBerths: Berth[];
  /** 紧急避风占用泊位 */
  emergencyBerths: Berth[];
}
