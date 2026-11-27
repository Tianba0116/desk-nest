import { describe, expect, it } from 'vitest';
import {
  detectRecurrence,
  formatInZone,
  fromZoned,
  resolveTime,
  toZoned,
  type TimeSpec,
} from '../../src/main/application/time-resolver';

const TZ = 'Asia/Shanghai';
/** 上海时间 → UTC 毫秒 */
const sh = (month: number, day: number, hour: number, minute = 0): number => Date.UTC(2026, month - 1, day, hour - 8, minute);
/** 2026-11-24 周二 09:00 */
const BASE = sh(11, 24, 9);

const at = (spec: TimeSpec, base = BASE): number | string => {
  const r = resolveTime(spec, base, TZ);
  return r.ok ? r.dueAt : r.reason;
};

describe('时间理解（TD §8.1）', () => {
  it('明天下午三点 → 次日 15:00；钟点按原话填，由本地换算', () => {
    expect(at({ relativeDays: 1, period: 'afternoon', hour: 3 })).toBe(sh(11, 25, 15));
    expect(formatInZone(sh(11, 25, 15), TZ)).toBe('2026年11月25日 周三 15:00');
  });

  it('各种时段', () => {
    expect(at({ relativeDays: 0, period: 'evening', hour: 8 })).toBe(sh(11, 24, 20));
    expect(at({ relativeDays: 2, period: 'noon', hour: 12 })).toBe(sh(11, 26, 12));
    expect(at({ relativeDays: 1, period: 'noon', hour: 1 })).toBe(sh(11, 25, 13));
    expect(at({ relativeDays: 1, period: 'morning', hour: 9, minute: 30 })).toBe(sh(11, 25, 9, 30));
    expect(at({ relativeDays: 1, period: 'early_morning', hour: 5 })).toBe(sh(11, 25, 5));
    // 半夜十二点 = 第二天 0 点
    expect(at({ period: 'night', hour: 12 })).toBe(sh(11, 25, 0));
    expect(at({ relativeDays: 1, hour: 21 })).toBe(sh(11, 25, 21));
  });

  it('没说时段：今天取最近的将来时刻；指定了日期时 1～6 点按下午', () => {
    expect(at({ hour: 3 })).toBe(sh(11, 24, 15));
    expect(at({ hour: 3 }, sh(11, 24, 16))).toBe(sh(11, 25, 3));
    expect(at({ hour: 10 })).toBe(sh(11, 24, 10));
    expect(at({ relativeDays: 1, hour: 3 })).toBe(sh(11, 25, 15));
    expect(at({ relativeDays: 1, hour: 8 })).toBe(sh(11, 25, 8));
  });

  it('星期和具体日期', () => {
    expect(at({ weekday: 5, period: 'evening', hour: 7, minute: 30 })).toBe(sh(11, 27, 19, 30));
    expect(at({ weekday: 1, weekOffset: 1, period: 'morning', hour: 9 })).toBe(sh(11, 30, 9));
    // 今天是周二：“周二下午三点”就是今天
    expect(at({ weekday: 2, period: 'afternoon', hour: 3 })).toBe(sh(11, 24, 15));
    expect(at({ date: '2026-12-03', period: 'morning', hour: 10 })).toBe(sh(12, 3, 10));
    expect(at({ date: '2026-02-30', hour: 10 })).toBe('INVALID_DATE');
  });

  it('N 分钟后以本轮基准时间计算', () => {
    expect(at({ inMinutes: 10 })).toBe(BASE + 10 * 60_000);
    expect(at({ inMinutes: 120, hour: 3 })).toBe(BASE + 120 * 60_000);
  });

  it('只说“下午”或“明天”：缺时刻', () => {
    expect(at({ period: 'afternoon' })).toBe('MISSING_TIME');
    expect(at({ relativeDays: 1 })).toBe('MISSING_TIME');
  });

  it('时间已经过去（R08.AC-4）：指定了今天时不猜；没指定日期时建议明天同一时刻', () => {
    expect(resolveTime({ relativeDays: 0, period: 'morning', hour: 8 }, BASE, TZ)).toEqual({
      ok: false,
      reason: 'PAST_TIME',
      dueAt: sh(11, 24, 8),
      suggestion: null,
    });
    expect(resolveTime({ period: 'morning', hour: 8 }, BASE, TZ)).toEqual({
      ok: false,
      reason: 'PAST_TIME',
      dueAt: sh(11, 24, 8),
      suggestion: sh(11, 25, 8),
    });
  });

  it('重复表达（R08.AC-7）：不支持，给出下一次发生的时间', () => {
    expect(resolveTime({ recurrence: 'daily', period: 'morning', hour: 8 }, BASE, TZ)).toEqual({
      ok: false,
      reason: 'UNSUPPORTED_RECURRENCE',
      recurrence: 'daily',
      next: sh(11, 25, 8),
    });
    // 周五 10 点说“工作日九点”：下一次是周一
    const friday = sh(11, 27, 10);
    expect(resolveTime({ recurrence: 'weekdays', hour: 9 }, friday, TZ)).toMatchObject({ next: sh(11, 30, 9) });
    expect(resolveTime({ recurrence: 'weekly', weekday: 1 }, BASE, TZ)).toMatchObject({ next: null });
  });

  it('本地规则识别明确的重复表达', () => {
    expect(detectRecurrence('每天早上八点提醒我喝水')).toBe('daily');
    expect(detectRecurrence('工作日每天九点提醒我打卡')).toBe('weekdays');
    expect(detectRecurrence('每周一提醒我交周报')).toBe('weekly');
    expect(detectRecurrence('每个月 1 号提醒我交房租')).toBe('monthly');
    expect(detectRecurrence('每隔两小时提醒我喝水')).toBe('other');
    expect(detectRecurrence('天天都要记得吃药')).toBe('daily');
    expect(detectRecurrence('明天下午三点提醒我改简历')).toBeNull();
  });

  it('时区换算不依赖系统时区', () => {
    const ms = fromZoned(2026, 7, 1, 9, 0, 'America/New_York');
    expect(ms).toBe(Date.UTC(2026, 6, 1, 13, 0));
    expect(toZoned(ms, 'America/New_York')).toMatchObject({ year: 2026, month: 7, day: 1, hour: 9, minute: 0, weekday: 3 });
    // 夏令时跳过的时刻不会变成 NaN
    expect(Number.isFinite(fromZoned(2026, 3, 8, 2, 30, 'America/New_York'))).toBe(true);
  });
});
