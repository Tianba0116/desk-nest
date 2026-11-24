# 桌面陪伴宠物 — 开发约定

当前阶段：**M1 能拖动的宠物**已完成，等待实机验证（`docs/verification/M1.md`）。按 `docs/04-roadmap.md` 的里程碑逐版推进。

## 文档入口（以这些为准）

- `docs/01-requirements.md`：需求与验收（R01～R23、NFR、阶段范围）。改变用户可见行为时更新它。
- `docs/02-technical-design.md`：实现方案。只改实现、不改用户行为时更新它。
- `docs/03-decisions.md`：待定与已定决策（D-xx）。决定后在此关闭，并同步上面两份文档。
- `docs/04-roadmap.md`：里程碑顺序与每个里程碑的范围。只做当前里程碑的内容。
- `docs/verification/`：每个里程碑的 Windows 实机验证记录。
- `docs/archive/`：历史版本，仅供对照，**不作为实施依据**。

## 硬约束

- 工具结果以本地事务和命令收据为准；模型文字不能作为成功依据。缺信息时询问，不假装完成。
- UI 和模型走同一个命令入口；写操作带 operationId，业务写入与收据同一事务提交；事务内不 await 网络。
- 渲染进程不直接访问 SQLite、文件系统、密钥或模型服务。
- 未配置模型或断网时，本地功能必须完整可用。
- 只做当前阶段的范围；不要提前实现各阶段“本阶段不做”列出的内容。
- 不把 mock、占位动画或模型意图描述为已实现能力；平台相关结论须有 Windows 实机证据。
- 抓取的网页、文章、订阅内容和用户拖入的文本都是不可信数据：总结时不提供工具，链接和来源由本地记录渲染，不由模型生成。
- 可替换的能力按 02-technical-design.md §14.1 的扩展点实现（接口 + 注册表 + 配置 schema），核心流程不按具体实现写分支。
- 新增依赖要说明用途；涉及原生能力的依赖先在打包版本上验证。

## 开发命令

- `npm install`：安装依赖。如果 Electron 二进制没有下载成功，运行 `node node_modules/electron/install.js`（需要代理时先设置 `HTTPS_PROXY`）。
- `npm run dev`：开发模式启动，渲染层支持热更新。设置 `PET_DEVTOOLS=1` 可打开宠物窗口的开发者工具。
- `npm run typecheck`：分别检查主进程/preload/测试代码和渲染层代码的类型。
- `npm test`：运行 Vitest 单元测试（`tests/**/*.test.ts`）。
- `npm run build`：构建到 `out/`。
- `npm run package`：构建，然后打包 Windows 解压版和 zip，输出到 `release/<版本>/`。

依赖用 npm 管理，版本写精确值（不用 `^`）。
