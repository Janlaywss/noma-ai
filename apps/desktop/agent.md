# Desktop Agent 指南

本文件约束 `apps/desktop` 内的后续修改。

## 必守边界

- UI 不直接读写 ACP 会话正文，所有会话能力通过 `@noma/agent` 的 ACP adapter 使用。
- Renderer 不直接访问 Keychain、文件系统敏感路径、子进程或原生网络代理。
- 连接器代码不写在 React 组件内，连接器生命周期由本地 service 调用 `@noma/connector` 管理。
- 登录注册和用户鉴权已移除；桌面端启动后直接进入本地模式。
- OAuth 连接器授权仍沿用 `apps/server` 的 connector OAuth 协议。
- 本地数据结构变化必须考虑迁移，不允许只改 TypeScript 类型。

## IPC 规则

- IPC API 必须类型化，按领域拆分：会话、任务、连接器、设置、通知。
- IPC 返回值使用结构化错误，不把 provider 原始错误直接透给 UI。
- 高风险动作必须通过确认流程，不能由事件 Agent 或 renderer 静默触发。
- preload 只能暴露白名单 API，不暴露任意命令执行、文件读取或 Node 对象。

## UI 规则

- 桌面端首屏应该是可用工作台，不做营销落地页。
- 会话、任务和连接器状态要能快速切换。
- 连接器授权范围、监听状态、最近错误和下一次轮询时间需要可见。
- 系统通知要能追溯到任务和触发事件摘要。
- 保持 Vite renderer 可以单独预览，Electron-only 能力必须有浏览器 fallback。

## 前端工程规则

- 路由使用 `react-router-dom`，`HashRouter` 模式（Electron 兼容）。入口在 `src/renderer/main.tsx`。
- 页面组件放在 `src/renderer/views/`，目录名 `views`，不叫 `screens` 或 `pages`。
- 共享 UI 组件放在 `src/renderer/components/`。
- 全局样式和设计 token 在 `src/renderer/styles.css`，使用 CSS custom properties（OKLCH 色值 + shadcn neutral 体系）。
- 字体：UI 文本用 Geist / Inter，等宽用 Geist Mono。不引入手写体。
- 每个 view 导出一个 default component，由 `App.tsx` 的 `<Routes>` 统一注册。
- 导航 sidebar 始终可见，使用 `NavLink` 管理 active 态；页面特定的 sidebar 内容由 `App.tsx` 内的嵌套 `<Routes>` 控制。
- 设计参考：`docs/design-ui/` 下的两份风格指南（中英文）和原始线框图。

## ACP Smoke 规则

- ACP smoke 的会话列表必须来自 `session/list`。
- ACP smoke 的对话回放必须来自 `session/load`，不得读本地业务数据库替代。
- LLM 请求必须经 server `/api/v1/*`，桌面端只做本地转发。
- CDP 脚本只做用户可见 UI 流程自动化，不直接调用主进程内部函数绕过 renderer。

## 隐私规则

- 不把会话正文、邮件正文、私有仓库内容或聊天原文发给 `apps/server`。
- 本地日志默认记录摘要和引用，不记录完整敏感 payload。
- 调试日志中不得输出 token、cookie、OAuth code、refresh token。
