// 专注（R09）的数据约定。只放类型和常量。

/**
 * running 进行中；paused 暂停；completed 按时结束；expired 在睡眠、锁屏或应用未运行期间到期；
 * finished 提前结束；cancelled 取消（不算专注）。
 */
export type FocusStatus = 'running' | 'paused' | 'completed' | 'expired' | 'finished' | 'cancelled';

export interface FocusDto {
  id: string;
  status: FocusStatus;
  plannedMs: number;
  /** 进行中：到期时间；其他状态为 null */
  dueAt: number | null;
  /** 暂停时的剩余时间 */
  remainingMs: number | null;
  /** clock_jump：检测到系统时间被大幅调整而自动暂停（R09.AC-7） */
  pauseReason: string | null;
  /** 本次计入的专注时长：以计划时长为上限，到期后经过的时间不计入（D-07） */
  countedMs: number | null;
  /** 期间锁屏和睡眠的时长，单独显示（D-07） */
  awayMs: number;
  /** 到期时电脑处于睡眠、锁屏或应用未运行，回来后才结算（R09.AC-4） */
  settledLate: boolean;
  task: { id: string; title: string; status: 'open' | 'done'; deleted: boolean } | null;
  startedAt: number;
  endedAt: number | null;
  revision: number;
}

export const FOCUS_PRESETS_MINUTES = [15, 25, 45, 60] as const;
export const FOCUS_MAX_MINUTES = 180;
/** 到期后超过这个时间才结算，视为期间电脑处于睡眠、锁屏或应用未运行 */
export const FOCUS_LATE_MS = 60_000;
/** 墙上时钟与单调时钟相差超过这个值，视为系统时间被调整 */
export const CLOCK_JUMP_MS = 5 * 60_000;
