// Windows 实现：通过 koffi 调用 user32/shell32 读取前台窗口和显示器信息。
// 不启动 PowerShell 子进程（TD §12.4）。加载或调用失败时返回 unknown，不影响其他功能。

import {
  evaluateFullscreen,
  type DesktopContextProvider,
  type ForegroundSnapshot,
  type Rect32,
  type Tristate,
} from './desktop-context';

type Handle = number | bigint;

interface Win32Api {
  getForegroundWindow(): Handle;
  getWindowProcessId(hwnd: Handle): number;
  getClassName(hwnd: Handle): string;
  getWindowRect(hwnd: Handle): Rect32 | null;
  isZoomed(hwnd: Handle): boolean;
  monitorFromWindow(hwnd: Handle): Handle;
  getMonitorRect(monitor: Handle): Rect32 | null;
  notificationState(): number | null;
}

const MONITOR_DEFAULTTONEAREST = 2;

export function createWin32DesktopContext(): DesktopContextProvider | null {
  let api: Win32Api;
  try {
    api = loadApi();
  } catch (error) {
    console.warn('[desktop-context] win32 api unavailable:', error);
    return null;
  }

  return {
    id: 'win32',
    queryFullscreen(petWindowHandle: Buffer): Tristate {
      try {
        return evaluateFullscreen(snapshot(api, petWindowHandle), api.notificationState());
      } catch (error) {
        console.warn('[desktop-context] query failed:', error);
        return 'unknown';
      }
    },
  };
}

function snapshot(api: Win32Api, petWindowHandle: Buffer): ForegroundSnapshot | null {
  const hwnd = api.getForegroundWindow();
  if (!hwnd) return null;
  const windowRect = api.getWindowRect(hwnd);
  const monitor = api.monitorFromWindow(hwnd);
  const monitorRect = monitor ? api.getMonitorRect(monitor) : null;
  if (!windowRect || !monitorRect) return null;
  const petMonitor = api.monitorFromWindow(handleFromBuffer(petWindowHandle));
  return {
    className: api.getClassName(hwnd),
    ownProcess: api.getWindowProcessId(hwnd) === process.pid,
    windowRect,
    maximized: api.isZoomed(hwnd),
    monitorRect,
    sameMonitorAsPet: BigInt(petMonitor) === BigInt(monitor),
  };
}

function handleFromBuffer(buffer: Buffer): bigint {
  return buffer.length >= 8 ? buffer.readBigUInt64LE(0) : BigInt(buffer.readUInt32LE(0));
}

function loadApi(): Win32Api {
  // 延迟加载：非 Windows 平台或原生文件缺失时不影响应用启动
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require('koffi') as typeof import('koffi');
  const user32 = koffi.load('user32.dll');
  const shell32 = koffi.load('shell32.dll');
  const RECT = koffi.struct('DN_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
  const MONITORINFO = koffi.struct('DN_MONITORINFO', {
    cbSize: 'uint32',
    rcMonitor: RECT,
    rcWork: RECT,
    dwFlags: 'uint32',
  });

  const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()');
  const GetWindowThreadProcessId = user32.func(
    'uint32_t __stdcall GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32_t *pid)',
  );
  const GetClassNameW = user32.func('int __stdcall GetClassNameW(intptr_t hWnd, _Out_ uint16_t *buf, int max)');
  const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr_t hWnd, _Out_ DN_RECT *rect)');
  const IsZoomed = user32.func('bool __stdcall IsZoomed(intptr_t hWnd)');
  const MonitorFromWindow = user32.func('intptr_t __stdcall MonitorFromWindow(intptr_t hWnd, uint32_t flags)');
  const GetMonitorInfoW = user32.func('bool __stdcall GetMonitorInfoW(intptr_t hMon, _Inout_ DN_MONITORINFO *mi)');
  const SHQueryUserNotificationState = shell32.func(
    'int32_t __stdcall SHQueryUserNotificationState(_Out_ int32_t *state)',
  );
  const monitorInfoSize = koffi.sizeof(MONITORINFO);

  return {
    getForegroundWindow: () => GetForegroundWindow() as Handle,
    getWindowProcessId(hwnd) {
      const pid = [0];
      GetWindowThreadProcessId(hwnd, pid);
      return pid[0] ?? 0;
    },
    getClassName(hwnd) {
      const buffer = Buffer.alloc(512);
      const length = GetClassNameW(hwnd, buffer, 256) as number;
      return buffer.toString('utf16le', 0, Math.max(0, length) * 2);
    },
    getWindowRect(hwnd) {
      const rect = {} as Rect32;
      return GetWindowRect(hwnd, rect) ? rect : null;
    },
    isZoomed: (hwnd) => IsZoomed(hwnd) as boolean,
    monitorFromWindow: (hwnd) => MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) as Handle,
    getMonitorRect(monitor) {
      const info = { cbSize: monitorInfoSize } as { cbSize: number; rcMonitor: Rect32 };
      return GetMonitorInfoW(monitor, info) ? info.rcMonitor : null;
    },
    notificationState() {
      const state = [0];
      return SHQueryUserNotificationState(state) === 0 ? (state[0] ?? null) : null;
    },
  };
}
