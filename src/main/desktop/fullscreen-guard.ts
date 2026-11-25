// 外部应用全屏时自动隐藏宠物，退出全屏后恢复（R02.AC-8、TD §12.4）。
// 结果未知时保持显示；宠物窗口只用普通置顶层级，不提升到会盖过全屏窗口的层级。

import type { DesktopContextProvider, Tristate } from './context/desktop-context';

/** 轮询前台窗口的间隔：每次只是几次 user32 调用，开销很小 */
const POLL_INTERVAL_MS = 1000;

export interface FullscreenTarget {
  /** 宠物窗口句柄；窗口不存在时返回 null */
  nativeHandle(): Buffer | null;
  setSuppressed(suppressed: boolean): void;
}

export class FullscreenGuard {
  private timer: NodeJS.Timeout | null = null;
  private last: Tristate = 'unknown';

  constructor(
    private readonly provider: DesktopContextProvider,
    private readonly target: FullscreenTarget,
    private readonly enabled: () => boolean,
  ) {}

  get state(): Tristate {
    return this.last;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), POLL_INTERVAL_MS);
    this.check();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.target.setSuppressed(false);
  }

  /** 设置变化后立即重新判断 */
  check(): void {
    const handle = this.target.nativeHandle();
    this.last = handle ? this.provider.queryFullscreen(handle) : 'unknown';
    this.target.setSuppressed(this.enabled() && this.last === true);
  }
}
