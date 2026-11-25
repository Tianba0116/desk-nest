// 提醒的展示（TD §11 P1 简化版）：信箱内容存在与“弹过气泡”分开记录。
// 能弹出时显示一个合并气泡，界面确认后写 shown_at；不能弹出（安静、隐藏、全屏、锁屏）时
// 只进信箱，可选另发系统通知，以后不补弹。

import type { BubbleItem } from '../../shared/contracts/reminders';
import { markShown, skipPopups, stillUnread, takePopupCandidates, unreadCount } from '../domains/reminders';
import type { Database } from '../storage/database';
import type { Clock } from './clock';

export interface PopupGate {
  /** 现在能否在桌面上弹出气泡；不能时给出原因码（便于诊断） */
  check(): { open: true } | { open: false; reason: string };
}

export interface BubbleChannel {
  /** 显示（或替换）气泡内容 */
  show(items: BubbleItem[]): void;
  hide(): void;
  readonly visibleIds: readonly string[];
}

export interface PresenterOptions {
  db: Database;
  clock: Clock;
  gate: PopupGate;
  bubble: BubbleChannel;
  /** 不能弹出时是否发系统通知 */
  notifyWhenClosed: () => boolean;
  systemNotify: (items: BubbleItem[]) => void;
  onUnreadChanged: (count: number) => void;
}

export class ReminderPresenter {
  private lastReason: string | null = null;

  constructor(private readonly options: PresenterOptions) {}

  get lastSuppressedReason(): string | null {
    return this.lastReason;
  }

  /** 有新的到期项、门禁变化或启动时调用 */
  check(): void {
    const { db, clock, gate, bubble } = this.options;
    const candidates = takePopupCandidates(db, clock.now());
    this.refreshUnread();
    if (candidates.length === 0) return;

    const decision = gate.check();
    if (decision.open) {
      this.lastReason = null;
      // 已在气泡里的项保留，合并新的到期项（R08.AC-6：相近到期合并展示）
      const shown = new Set(candidates.map((c) => c.inboxId));
      const keep = bubble.visibleIds.filter((id) => !shown.has(id));
      bubble.show([...this.itemsFor(keep), ...candidates]);
      return;
    }
    this.lastReason = decision.reason;
    skipPopups(
      db,
      candidates.map((c) => c.inboxId),
      clock.now(),
    );
    if (this.options.notifyWhenClosed()) this.options.systemNotify(candidates);
  }

  /** 气泡界面确认已显示 */
  acknowledge(inboxIds: string[]): void {
    markShown(this.options.db, inboxIds, this.options.clock.now());
  }

  /** 信箱数据变化（已读、改期、取消）：更新未读数；气泡里已经无效的项移除 */
  onInboxChanged(): void {
    this.refreshUnread();
    const { bubble, db } = this.options;
    if (bubble.visibleIds.length === 0) return;
    const remaining = stillUnread(db, [...bubble.visibleIds]);
    if (remaining.length === bubble.visibleIds.length) return;
    if (remaining.length === 0) bubble.hide();
    else bubble.show(this.itemsFor(remaining));
  }

  private refreshUnread(): void {
    this.options.onUnreadChanged(unreadCount(this.options.db));
  }

  private itemsFor(inboxIds: readonly string[]): BubbleItem[] {
    const { db } = this.options;
    return inboxIds.flatMap((id) => {
      const row = db.get<{ id: string; source_id: string; content: string; due_at: number }>(
        `SELECT i.id, i.source_id, a.content, i.due_at FROM inbox_items i
         JOIN scheduled_actions a ON a.id = i.source_id WHERE i.id = ? AND i.status = 'unread'`,
        id,
      );
      return row ? [{ inboxId: row.id, reminderId: row.source_id, content: row.content, dueAt: row.due_at }] : [];
    });
  }
}
