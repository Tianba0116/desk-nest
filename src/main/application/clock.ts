// 可替换的时钟（TD §14）：测试使用可控时钟。

export interface Clock {
  /** UTC 毫秒 */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class ManualClock implements Clock {
  constructor(private current: number) {}

  now(): number {
    return this.current;
  }

  set(value: number): void {
    this.current = value;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
