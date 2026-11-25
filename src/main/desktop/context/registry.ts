// DesktopContextProvider 注册表：按平台选择实现，核心流程只依赖接口（TD §14.1）。
// 新平台：实现 DesktopContextProvider，在这里登记工厂即可。

import { unknownDesktopContext, type DesktopContextProvider } from './desktop-context';
import { createWin32DesktopContext } from './win32-desktop-context';

type ProviderFactory = () => DesktopContextProvider | null;

const factories: Partial<Record<NodeJS.Platform, ProviderFactory>> = {
  win32: createWin32DesktopContext,
};

export function createDesktopContext(platform: NodeJS.Platform = process.platform): DesktopContextProvider {
  return factories[platform]?.() ?? unknownDesktopContext;
}
