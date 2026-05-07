# Desktop App

`apps/desktop` 是 Noma AI 的桌面端应用，使用 Vite + React + Electron。当前已落地最小可运行桌面壳：renderer 展示 Agent 工作台，main 进程接入 `@noma/connector` 内置连接器注册表，并通过 `@noma/agent` 检测 `codex-acp` 二进制。

## 职责

- 提供多会话聊天界面、任务视图、连接器授权与监听状态视图。
- 启动或连接本地 `codex-acp`，通过 `@noma/agent` 使用 ACP 能力。
- 管理 Electron main/preload/renderer 的边界。
- 维护本地数据库、系统 Keychain 引用、任务索引和连接器状态。
- 复用 `apps/server` 的 OAuth、连接器授权和 LLM proxy 能力。
- 将前端资源、内置连接器 manifest、运行时脚本和迁移脚本打入 Electron 包。

## 非职责

- 不直接实现具体连接器逻辑。
- 不绕过 ACP 自行保存会话正文。
- 不把连接器密钥、事件原文或任务推理上下文上传到服务端。
- 不在 renderer 进程直接访问系统密钥或文件系统敏感路径。

## 进程结构

```text
desktop
├── src/main.ts              # Electron 主进程
├── src/preload.cts          # 受控 IPC API
├── src/renderer/App.tsx     # React 工作台
├── scripts/dev.mjs          # Vite + Electron 本地联调脚本
├── vite.config.ts
└── tsconfig.electron.json
```

建议边界：

- `main` 拥有 Node/Electron 权限。
- `preload` 只暴露类型化 IPC，不暴露任意文件或命令执行能力。
- `renderer` 只处理 UI 状态和用户交互。
- 连接器运行时优先放在独立 worker、utility process 或受控 service 中运行。

## 本地数据

桌面端保存：

- `session_index`：ACP session 的本地展示索引。
- `tasks`：任务元数据和 ACP session 引用。
- `connector_claims`：任务认领连接器的绑定关系。
- `connector_state`：轮询 cursor、去重水位、调度状态。
- `event_log`：事件摘要、决策摘要、动作结果。
- `secret_refs`：系统 Keychain 或本地加密存储引用。

桌面端不保存完整 ACP 会话正文副本。

## 模型配置

模型通过 **设置 → 模型** 页面配置，存储在本地 SQLite `settings` 表中。支持的字段：

| 设置键 | 说明 |
|--------|------|
| `model.agent` | 主对话 Agent 模型（OpenRouter 模型 ID） |
| `model.event` | 事件批量分析模型（OpenRouter 模型 ID） |

也可以通过 `.env` 中的 `NOMA_AGENT_MODEL` / `NOMA_EVENT_MODEL` 设置。优先级：设置页 > `.env`。未配置时使用相关功能会报错。

## 服务端复用

登录注册和用户鉴权已移除。桌面端启动后直接进入本地模式；Agent 会话、任务、事件和连接器运行状态仍保存在本地 SQLite。

OAuth 连接器授权推荐流程：

1. 桌面端打开服务端 OAuth 授权入口。
2. 服务端处理 provider callback。
3. 桌面端接收授权完成信号。
4. 连接器凭据写入本地安全存储。
5. 任务 claim 按权限范围启用连接器。

## 开发命令

命令入口：

```bash
pnpm --filter @noma/desktop dev
pnpm --filter @noma/desktop dev:renderer
pnpm --filter @noma/desktop build
pnpm --filter @noma/desktop typecheck
pnpm --filter @noma/desktop lint
pnpm --filter @noma/desktop smoke:acp
```

`dev` 会先编译 Electron main/preload，再从 `5173` 起扫描空闲端口启动 Vite，随后把同一个 `VITE_DEV_SERVER_URL` 注入 Electron。只看 renderer 时可用 `dev:renderer`。

## ACP Smoke

`smoke:acp` 使用 CDP 驱动 Electron UI：

- 自动启动 `apps/server`。
- 打开 Electron remote debugging 端口。
- 点击 UI 中的 `运行 ACP Smoke`。
- 主进程通过 `@noma/agent` 启动 `codex-acp`，会话列表来自 ACP `session/list`，对话内容来自 ACP `session/load`。
- LLM 请求经桌面本地 proxy 转发到 server `/api/v1/responses`。

可选环境变量：

```bash
NOMA_ACP_SMOKE_SERVER_PORT=3679
NOMA_ACP_SMOKE_CDP_PORT=9339
NOMA_ACP_SMOKE_PROMPT='请只回复 NOMA_ACP_SMOKE_OK，不要解释，不要调用工具。'
```

Smoke 测试使用设置页中配置的 Agent 模型。

## 验收重点

- 离线状态下仍能打开历史本地会话索引和任务列表。
- 用户未确认时，高风险连接器动作不会执行。
- 关闭窗口后，任务监听生命周期与用户设置一致。
- 打包产物包含桌面端所需静态资源和内置连接器资源。
