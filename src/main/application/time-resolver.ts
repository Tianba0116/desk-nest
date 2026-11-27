// 中文时间理解的本地部分（TD §8.1）：模型只填语义结构，这里用本轮基准时间和时区算出绝对时间。
// 不依赖系统时区；所有换算都按传入的 IANA 时区进行。

import { z } from 'zod';

export const RECURRENCES = ['daily', 'weekdays', 'weekly', 'monthly', 'yearly', 'other'] as const;
export type Recurrence = (typeof RECURRENCES)[number];

export const PERIODS = ['early_morning', 'morning', 'noon', 'afternoon', 'evening', 'night'] as const;
export type Period = (typeof PERIODS)[number];

/** 模型填写的时间语义结构；未提到的字段留空（null） */
export const TimeSpec = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish()
    .describe('用户说了具体日期时填，格式 YYYY-MM-DD，例如“12月3日”'),
  relativeDays: z.number().int().min(0).max(366).nullish().describe('相对今天的天数：今天 0，明天 1，后天 2，大后天 3'),
  weekday: z.number().int().min(1).max(7).nullish().describe('星期几：周一 1 … 周日 7'),
  weekOffset: z.number().int().min(0).max(4).nullish().describe('配合 weekday：本周 0，下周 1；没说就留空'),
  period: z
    .enum(PERIODS)
    .nullish()
    .describe('时段：凌晨 early_morning，早上/上午 morning，中午 noon，下午 afternoon，傍晚/晚上 evening，半夜/深夜 night'),
  hour: z.number().int().min(0).max(24).nullish().describe('用户说的钟点数字，按原话填，例如“下午三点”填 3，不要换算成 15'),
  minute: z.number().int().min(0).max(59).nullish().describe('分钟；“半”填 30，“一刻”填 15'),
  inMinutes: z
    .number()
    .int()
    .min(1)
    .max(60 * 24 * 366)
    .nullish()
    .describe('“N 分钟后”“N 小时后”换算成分钟数；用了这个字段就不用填其他字段'),
  recurrence: z
    .enum(RECURRENCES)
    .nullish()
    .describe('用户说了重复表达时填：每天 daily，工作日 weekdays，每周 weekly，每月 monthly，每年 yearly，其他 other'),
});
export type TimeSpec = z.output<typeof TimeSpec>;

export type TimeResolution =
  | { ok: true; dueAt: number }
  | { ok: false; reason: 'MISSING_TIME' }
  | { ok: false; reason: 'INVALID_DATE' }
  /** 算出来的时间已经过去；suggestion 是可选的下一次（只在没有指定日期时给出） */
  | { ok: false; reason: 'PAST_TIME'; dueAt: number; suggestion: number | null }
  /** 重复提醒暂不支持；next 是下一次发生的时间（缺时刻时为 null） */
  | { ok: false; reason: 'UNSUPPORTED_RECURRENCE'; recurrence: Recurrence; next: number | null };

// ---------- 时区换算 ----------

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 周一 1 … 周日 7 */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAY_INDEX: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function toZoned(ms: number, timeZone: string): ZonedParts & { second: number } {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    year: Number(parts['year']),
    month: Number(parts['month']),
    day: Number(parts['day']),
    hour: Number(parts['hour']) % 24,
    minute: Number(parts['minute']),
    second: Number(parts['second']),
    weekday: WEEKDAY_INDEX[parts['weekday'] ?? ''] ?? 1,
  };
}

/** 本地日期时刻 → UTC 毫秒。不存在的时刻（夏令时跳过）向后取到存在的时刻 */
export function fromZoned(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const z = toZoned(guess, timeZone);
    const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
    const diff = wall - asUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

/** 日历日期加减天数（与时区无关的纯日期运算） */
function addDays(date: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function weekdayOf(date: { year: number; month: number; day: number }): number {
  const w = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return w === 0 ? 7 : w;
}

const WEEKDAY_TEXT = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const pad = (n: number): string => String(n).padStart(2, '0');

/** 完整的本地日期、星期和时刻，例如“2026年11月28日 周六 15:00”（R08.AC-2） */
export function formatInZone(ms: number, timeZone: string): string {
  const z = toZoned(ms, timeZone);
  return `${z.year}年${z.month}月${z.day}日 ${WEEKDAY_TEXT[z.weekday]} ${pad(z.hour)}:${pad(z.minute)}`;
}

// ---------- 解析 ----------

/** 把用户说的钟点和时段换成 24 小时制；可能顺延到第二天（例如“半夜十二点”） */
function toHour24(hour: number, period: Period | null | undefined): { hour: number; extraDays: number } | 'AMBIGUOUS' {
  if (hour === 24) return { hour: 0, extraDays: 1 };
  switch (period) {
    case 'early_morning':
      return { hour: hour === 12 ? 0 : hour, extraDays: 0 };
    case 'morning':
      return { hour, extraDays: 0 };
    case 'noon':
      return { hour: hour >= 1 && hour <= 3 ? hour + 12 : hour, extraDays: 0 };
    case 'afternoon':
    case 'evening':
      return { hour: hour >= 1 && hour <= 11 ? hour + 12 : hour, extraDays: 0 };
    case 'night':
      if (hour === 12 || hour === 0) return { hour: 0, extraDays: 1 };
      if (hour <= 5) return { hour, extraDays: 1 };
      return { hour: hour < 12 ? hour + 12 : hour, extraDays: 0 };
    default:
      // 没说时段：0 点和 13 点以后无歧义，其余交给调用方按日期判断
      return hour === 0 || hour > 12 ? { hour, extraDays: 0 } : 'AMBIGUOUS';
  }
}

interface DayChoice {
  date: { year: number; month: number; day: number };
  /** 用户是否指定了日期（今天/明天/周五/具体日期） */
  given: boolean;
}

function chooseDay(spec: TimeSpec, today: ZonedParts): DayChoice | 'INVALID' {
  if (spec.date) {
    const [y, m, d] = spec.date.split('-').map(Number) as [number, number, number];
    const check = new Date(Date.UTC(y, m - 1, d));
    if (check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return 'INVALID';
    return { date: { year: y, month: m, day: d }, given: true };
  }
  if (spec.relativeDays != null) return { date: addDays(today, spec.relativeDays), given: true };
  if (spec.weekday != null) {
    // 本周从周一开始；没说“本周/下周”时取最近的一个（今天或以后）
    const monday = addDays(today, 1 - today.weekday);
    if (spec.weekOffset != null) return { date: addDays(monday, spec.weekOffset * 7 + spec.weekday - 1), given: true };
    const ahead = (spec.weekday - today.weekday + 7) % 7;
    return { date: addDays(today, ahead), given: true };
  }
  return { date: { year: today.year, month: today.month, day: today.day }, given: false };
}

/** 计算一次性的时间，不考虑重复表达 */
function resolveOnce(spec: TimeSpec, base: number, timeZone: string, daytime = false): TimeResolution {
  if (spec.inMinutes != null) return { ok: true, dueAt: base + spec.inMinutes * 60_000 };
  const today = toZoned(base, timeZone);
  const day = chooseDay(spec, today);
  if (day === 'INVALID') return { ok: false, reason: 'INVALID_DATE' };
  if (spec.hour == null) return { ok: false, reason: 'MISSING_TIME' };
  const minute = spec.minute ?? 0;
  const at = (date: DayChoice['date'], hour: number): number => fromZoned(date.year, date.month, date.day, hour, minute, timeZone);

  const h = toHour24(spec.hour, spec.period);
  let dueAt: number;
  if (h === 'AMBIGUOUS') {
    if (!day.given && !daytime) {
      // “三点提醒我”：取最近的将来时刻（今天 3 点、今天 15 点、明天 3 点）
      const candidates = [at(day.date, spec.hour % 12), at(day.date, (spec.hour % 12) + 12), at(addDays(day.date, 1), spec.hour % 12)];
      dueAt = candidates.find((c) => c > base) ?? (candidates[2] as number);
    } else {
      // “明天三点”、重复表达里的“九点”：1～6 点按下午，7～12 点按上午/中午；卡片显示完整时刻，可立即修改
      const hour = spec.hour === 12 ? 12 : spec.hour <= 6 ? spec.hour + 12 : spec.hour;
      dueAt = at(day.date, hour);
    }
  } else {
    dueAt = at(addDays(day.date, h.extraDays), h.hour);
  }

  if (dueAt <= base) {
    const suggestion = day.given ? null : dueAt + 24 * 3600_000 > base ? nextDaySameTime(dueAt, timeZone) : null;
    return { ok: false, reason: 'PAST_TIME', dueAt, suggestion };
  }
  return { ok: true, dueAt };
}

function nextDaySameTime(ms: number, timeZone: string): number {
  const z = toZoned(ms, timeZone);
  const next = addDays(z, 1);
  return fromZoned(next.year, next.month, next.day, z.hour, z.minute, timeZone);
}

/** 重复表达的下一次发生时间（只用于“只设置下一次”） */
function nextOccurrence(spec: TimeSpec, recurrence: Recurrence, base: number, timeZone: string): number | null {
  const once = resolveOnce({ ...spec, recurrence: null }, base, timeZone, true);
  let candidate: number;
  if (once.ok) candidate = once.dueAt;
  else if (once.reason === 'PAST_TIME') candidate = once.dueAt;
  else return null;
  const step = recurrence === 'weekly' && spec.weekday != null ? 7 : 1;
  for (let i = 0; i < 14; i++) {
    const z = toZoned(candidate, timeZone);
    const isWorkday = weekdayOf(z) <= 5;
    if (candidate > base && (recurrence !== 'weekdays' || isWorkday)) return candidate;
    const next = addDays(z, step);
    candidate = fromZoned(next.year, next.month, next.day, z.hour, z.minute, timeZone);
  }
  return null;
}

export function resolveTime(spec: TimeSpec, base: number, timeZone: string): TimeResolution {
  if (spec.recurrence) {
    return { ok: false, reason: 'UNSUPPORTED_RECURRENCE', recurrence: spec.recurrence, next: nextOccurrence(spec, spec.recurrence, base, timeZone) };
  }
  return resolveOnce(spec, base, timeZone);
}

// ---------- 本地规则层 ----------

const RECURRENCE_RULES: Array<[RegExp, Recurrence]> = [
  [/每个?工作日|工作日每天|周一到周五每天/, 'weekdays'],
  [/每天|每日|天天|每晚|每天早上|每早|每个?晚上|每个?早上/, 'daily'],
  [/每周|每星期|每个?礼拜|每个?(周|星期|礼拜)[一二三四五六日天]/, 'weekly'],
  [/每个?月|每月/, 'monthly'],
  [/每年/, 'yearly'],
  [/每隔|每\s*\d+\s*(分钟|小时|天)|每[两三四五六七八九十]+(分钟|小时|天)/, 'other'],
];

/**
 * 检查原文里明确的重复表达（R08.AC-7）。模型漏填 recurrence 时，
 * 仍然不会静默只建一次。
 */
export function detectRecurrence(text: string): Recurrence | null {
  for (const [pattern, kind] of RECURRENCE_RULES) if (pattern.test(text)) return kind;
  return null;
}

/**
 * 有效期的结束时刻（R11.AC-6）：今天 / 本周（到周日）/ 本月 / N 天后，取那一天的 24:00（第二天 0 点）。
 */
export function endOfPeriod(
  base: number,
  timeZone: string,
  period: { until?: 'today' | 'this_week' | 'this_month' | null; days?: number | null },
): number | null {
  const today = toZoned(base, timeZone);
  let last: { year: number; month: number; day: number } | null = null;
  if (period.days != null && period.days > 0) last = addDays(today, period.days - 1);
  else if (period.until === 'today') last = today;
  else if (period.until === 'this_week') last = addDays(today, 7 - today.weekday);
  else if (period.until === 'this_month') last = addDays({ year: today.year, month: today.month + 1, day: 1 }, -1);
  if (!last) return null;
  const next = addDays(last, 1);
  return fromZoned(next.year, next.month, next.day, 0, 0, timeZone);
}
