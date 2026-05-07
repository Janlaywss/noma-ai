# @noma/connector

连接器插件和运行时。轮询外部服务（GitHub、Gmail、飞书、Yahoo Finance、Open-Meteo、金十、OpenSky），产出事件；用户自定义连接器以沙箱 JS 执行。

不依赖 Electron / Next.js / 任何 DB client。所有副作用通过 `ConnectorContext` 和 `ConnectorRuntimeHost` 注入，桌面端、服务端、eval 均可复用。

## 目录结构

```
src/
  types.ts             接口定义
  registry.ts          CONNECTOR_REGISTRY
  runtime.ts           ConnectorRuntime + coerce + aggregateConfigs
  app/<name>.ts        各连接器 descriptor
tests/
  helpers/             mock context / fetch / host
  runtime.test.ts      运行时逻辑
  registry.test.ts     注册表契约
  connectors/*.ts      各连接器单测
scripts/
  live-smoke.ts        真实网络冒烟
```

## 核心概念

| 概念 | 说明 |
|------|------|
| Descriptor | 静态插件定义：`name`、`configSchema`、`defaults`、`create(config, ctx)` |
| Connector | `create()` 产出的运行实例，拥有轮询循环和去重状态，`stop()` 清理 |
| ConnectorContext | 宿主注入的回调：`emitEvent`、`log`、`storage` |
| ConnectorRuntime | 按 `connector_name + identity_params` 做实例共享与热重载；`dyn_*` 不共享 |
| Config 聚合 | `string[]` 取并集，`number` 取最小，`boolean` 取 OR，`string` 取首个非空值 |

## 测试

### 全量

```bash
pnpm test:connector
```

81 tests / 10 files，约 600ms，全离线。

### 单个连接器

```bash
pnpm --filter @noma/connector test -- tests/connectors/github.test.ts
pnpm --filter @noma/connector test:watch -- tests/connectors/weather
```

### 真实网络冒烟

```bash
pnpm test:connector:live                          # 全部（缺凭据自动跳过）
pnpm test:connector:live weather --country=US --city="New York" --wait=10
GITHUB_TOKEN=ghp_... pnpm test:connector:live github
```

退出码：`0` 全部通过或跳过，`1` 有失败，`2` 请求了未知连接器。

| 连接器 | 必填参数 | 环境变量 |
|--------|----------|----------|
| github | `token` | `GITHUB_TOKEN` |
| gmail | `access_token` + refresh | `GMAIL_ACCESS_TOKEN` `GMAIL_REFRESH_TOKEN` `GOOGLE_CLIENT_ID` `GOOGLE_CLIENT_SECRET` |
| lark | `appId` `appSecret` | `LARK_APP_ID` `LARK_APP_SECRET` |
| stock | `symbols` | `STOCK_SYMBOLS`（逗号分隔） |
| weather | `country` `city` | `WEATHER_COUNTRY` `WEATHER_CITY` |
| flight | `flightNumber` | `FLIGHT_NUMBER` |
| jin10 | 无 | — |

## 新增连接器

1. `src/app/<name>.ts` 导出 `ConnectorDescriptor`
2. `src/registry.ts` 注册，`src/index.ts` 导出
3. `tests/connectors/<name>.test.ts`：空配置跳过、正常出事件、去重/游标推进、HTTP 错误容忍、`updateConfig`（如有）。用 `installFetchMock` 保持离线
4. `scripts/live-smoke.ts` 的 `ENV_KEYS` 加映射
5. 更新上面的表格

## 新增运行时特性

用 `makeFakeDescriptor()`（`tests/helpers/mock-host.ts`）测试，不耦合真实连接器代码。
