// 本地时间的展示格式。主进程（系统通知）和渲染层共用。

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 例如“11月24日 周二 17:54”；不是今年时带年份 */
export function formatTime(ms: number, now: number = Date.now()): string {
  const date = new Date(ms);
  const year = date.getFullYear() === new Date(now).getFullYear() ? '' : `${date.getFullYear()}年`;
  return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()]} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 完整的本地日期、星期和时刻，例如“2026年11月25日 周三 15:00”（R08.AC-2） */
export function formatFullDateTime(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()]} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 只有时刻，例如“15:00” */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** datetime-local 输入框的值 ↔ 本地时间毫秒 */
export function toLocalInputValue(ms: number | null): string {
  if (ms === null) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInputValue(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}
