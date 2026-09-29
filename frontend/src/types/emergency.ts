/** 紧急回港状态 */
export type EmergencyStatus = '生效中' | '已释放';

export const EMERGENCY_STATUSES: EmergencyStatus[] = ['生效中', '已释放'];

/** 释放原因 */
export type EmergencyReleaseReason = '手动释放' | '超时释放';

/**
 * 紧急回港限时占用记录。
 * 台风压境时证书过期的渔船也可临时回港避险，到期释放后记录仍保留（status=已释放）。
 */
export interface EmergencyStay {
  id: string;
  /** 紧急回港渔船 id */
  vesselId: string;
  /** 渔船名（冗余） */
  vesselName: string;
  /** 避风渔港 id */
  portId: string;
  /** 渔港名（冗余） */
  portName: string;
  /** 泊位 id */
  berthId: string;
  /** 泊位号（冗余） */
  berthNo: string;
  /** 申报避风等级（台风风力级） */
  typhoonLevel: number;
  /** 申报时估算的船舶吃水 m */
  vesselDraft: number;
  /** 批准停留时长 h */
  durationHours: number;
  /** 靠泊时间（ISO 字符串） */
  startAt: string;
  /** 到期时间（ISO 字符串） */
  expireAt: string;
  /** 状态：生效中 / 已释放 */
  status: EmergencyStatus;
  /** 实际释放时间 */
  releasedAt: string | null;
  /** 释放原因：手动释放 / 超时释放 */
  releaseReason: EmergencyReleaseReason | null;
  /** 申报时证书是否已过期（紧急回港允许过期，但留痕） */
  certificateExpired: boolean;
  /** 被挤走的普通船 id（无挤用为空） */
  displacedVesselId: string | null;
  /** 被挤走的普通船名 */
  displacedVesselName: string | null;
  /** 挤用发生时间 */
  displacedAt: string | null;
  createdAt: string;
}

/** 改派提醒：普通船被紧急船挤走后留下的记录 */
export interface ReassignmentNotice {
  id: string;
  /** 关联的紧急占用 id */
  stayId: string;
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
  /** 被挤走时间（ISO 字符串） */
  displacedAt: string;
  /** 改派建议文案 */
  suggestion: string;
  /** 值班员是否已阅知 */
  read: boolean;
  createdAt: string;
}

/** 紧急回港申报表单 */
export interface EmergencyDraft {
  vesselId: string;
  portId: string;
  /** 避风等级（台风级） */
  typhoonLevel: number;
  /** 停留时长 h */
  durationHours: number;
  /** 挤用普通船前的确认勾选 */
  bumpConfirmed: boolean;
}

export function emptyEmergencyDraft(): EmergencyDraft {
  return {
    vesselId: '',
    portId: '',
    typhoonLevel: 10,
    durationHours: 12,
    bumpConfirmed: false,
  };
}
