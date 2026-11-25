// 到期调度（TD §8.3、§14.1 定时任务扩展点）。
// 最近到期定时器保证低延迟，短周期兜底扫描应对时钟跳变、睡眠和定时器漂移。
// 新的定时任务类型：实现 JobHandler 并在组合根注册，不修改调度核心。

import type { Database } from '../storage/database';
import type { Clock } from './clock';

export interface JobHandler {
  kind: string;
  /** 最近一次到期时间；没有待执行的返回 null */
  nextDue(db: Database): number | null;
  /** 处理已到期的项（自行开短事务，幂等）；返回产生的新结果数量 */
  run(db: Database, now: number): number;
}

/** 兜底扫描间隔（TD §8.3 建议 15～30 秒） */
export const FALLBACK_INTERVAL_MS = 20_000;
/** setTimeout 的上限约 24.8 天；远期计划分段等待 */
const MAX_TIMER_MS = 60 * 60 * 1000;

export class Scheduler {
  private readonly handlers: JobHandler[] = [];
  private timer: NodeJS.Timeout | null = null;
  private fallback: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    /** 有新结果（例如提醒入箱）时回调 */
    private readonly onProduced: (count: number) => void,
  ) {}

  register(handler: JobHandler): void {
    this.handlers.push(handler);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.fallback = setInterval(() => this.tick(), FALLBACK_INTERVAL_MS);
    this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.fallback) clearInterval(this.fallback);
    this.timer = null;
    this.fallback = null;
  }

  /** 立即扫描一次并重排定时器：计划变更、睡眠恢复、解锁时调用 */
  tick(): void {
    let produced = 0;
    const now = this.clock.now();
    for (const handler of this.handlers) {
      try {
        produced += handler.run(this.db, now);
      } catch (error) {
        console.error(`[scheduler] ${handler.kind} failed:`, error);
      }
    }
    if (produced > 0) this.onProduced(produced);
    this.arm();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.running) return;
    let next: number | null = null;
    for (const handler of this.handlers) {
      try {
        const due = handler.nextDue(this.db);
        if (due !== null && (next === null || due < next)) next = due;
      } catch (error) {
        console.error(`[scheduler] ${handler.kind} nextDue failed:`, error);
      }
    }
    if (next === null) return;
    const delay = Math.min(Math.max(0, next - this.clock.now()) + 50, MAX_TIMER_MS);
    this.timer = setTimeout(() => this.tick(), delay);
  }
}
