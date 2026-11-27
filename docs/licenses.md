# 来源与许可（R20.AC-3）

更新：2026-11-27，版本 0.1.0。随应用发布的第三方代码如下；开发时使用、不随应用发布的工具（TypeScript、Vite、Vitest、electron-builder 等）不在此列。

| 组件 | 版本 | 许可 | 来源 | 用途 |
| --- | --- | --- | --- | --- |
| Electron | 45.4.1 | MIT | https://github.com/electron/electron | 桌面容器（含 Chromium、Node.js，许可见安装目录的 `LICENSE.electron.txt`、`LICENSES.chromium.html`） |
| React、React DOM | 19.3.1 | MIT | https://github.com/facebook/react | 小窝、对话、气泡、宠物窗口的界面 |
| scheduler | 0.28.0 | MIT | https://github.com/facebook/react | React 的依赖 |
| Zod | 4.6.7 | MIT | https://github.com/colinhacks/zod | IPC 和命令参数校验 |
| koffi | 3.3.7 | MIT | https://github.com/Koromix/koffi | 调用 Windows user32 识别外部全屏（M2） |

## 美术、字体、音效

- 角色：占位图形，由代码绘制，没有使用外部素材。正式角色在 P2 制作（D-10）。
- 字体：使用系统字体（Segoe UI、微软雅黑），不随应用分发。
- 音效：没有。
- 图标：暂用 Electron 默认图标。

## 模型服务

应用不内置任何模型。用户自行配置的服务（DeepSeek、通义千问、Kimi、智谱、Ollama 等）按各自的服务条款使用。
