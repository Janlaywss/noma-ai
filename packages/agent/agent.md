# @noma/agent 编辑指南

本文件约束 `packages/agent` 内的后续修改。

## 必守边界

- ACP 是会话读写事实来源，本包不得自建会话正文存储。
- 子进程、stdio、MCP 配置和 Codex home 写入要保持可审计，不隐藏失败。
- 不在本包内引入 Electron、React、Hono 或 Supabase。
- 不直接调用外部连接器 provider；外部动作必须通过桌面端工具或 `@noma/connector`。
- `resolveCodexBinary` 要兼容显式路径、环境变量、Electron 打包路径和 npm 安装路径。
- 会话列表和对话回放能力必须优先使用 ACP `session/list`、`session/load`，不要在本包引入业务数据库索引。

## 改 ACP 桥接

- 保持 `AcpAgentBridge` 生命周期清晰：`start`、`newSession`、`loadSession`、`prompt`、`cancel`、`stop`。
- ACP notification 转换成 `AgentRunEvent` 时不要丢失错误信息。
- transcript 捕获应基于原始 `session/update`，确保 user/agent 历史回放可被 smoke test 验证。
- 权限请求默认策略不能扩大权限；高风险动作应交给上层确认。
- 子进程退出必须清理本地连接状态。

## 改 launcher

- 写入 `config.toml`、模型目录或 instructions 时只写到调用方传入的 `codexHome`。
- MCP tools 路径解析失败应返回可诊断结果，不要静默假装已挂载。
- 不把真实 API key 写入仓库或日志。

## 测试规则

- 修改 ACP 协议适配时增加 adapter mock 测试或在 `apps/eval` 增加集成 smoke。
- 修改二进制解析逻辑时覆盖显式路径、环境变量和 npm 包路径。
