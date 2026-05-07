import { describe, it, expect } from "vitest";
import { aggregateConfigs, coerce, ConnectorRuntime } from "../src/runtime.js";
import type { ConfigField } from "../src/types.js";
import { createMockHost, makeFakeDescriptor, makeUsage } from "./helpers/mock-host.js";

// ─── coerce — 把 host/DB 传来的原始值按 schema 类型规整 ──────────

describe("coerce — 配置项类型强转", () => {
  const schema: ConfigField[] = [
    { key: "name", type: "string" },
    { key: "token", type: "string", secret: true },
    { key: "count", type: "number" },
    { key: "enabled", type: "boolean" },
    { key: "tags", type: "string[]" },
  ];

  it("将数字字符串转为 number", () => {
    expect(coerce(schema, { count: "42" })).toEqual({ count: 42 });
  });

  it("忽略 NaN / 非有限数等非法 number", () => {
    // 非法值不写入结果，避免后续 Math.min 等运算被污染
    expect(coerce(schema, { count: "abc" })).toEqual({});
    expect(coerce(schema, { count: NaN })).toEqual({});
  });

  it("真值统一转 boolean true（true / 'true' / 1 / '1'）", () => {
    expect(coerce(schema, { enabled: true }).enabled).toBe(true);
    expect(coerce(schema, { enabled: "true" }).enabled).toBe(true);
    expect(coerce(schema, { enabled: 1 }).enabled).toBe(true);
    expect(coerce(schema, { enabled: "1" }).enabled).toBe(true);
  });

  it("假值统一转 boolean false", () => {
    expect(coerce(schema, { enabled: false }).enabled).toBe(false);
    expect(coerce(schema, { enabled: "false" }).enabled).toBe(false);
    expect(coerce(schema, { enabled: 0 }).enabled).toBe(false);
  });

  it("逗号分隔字符串拆成 string[]", () => {
    expect(coerce(schema, { tags: "a,b ,  c" })).toEqual({ tags: ["a", "b", "c"] });
  });

  it("已经是数组的 string[] 保持原样", () => {
    expect(coerce(schema, { tags: ["x", "y"] })).toEqual({ tags: ["x", "y"] });
  });

  it("secret 字段忽略空字符串（避免不小心清空已存的凭据）", () => {
    expect(coerce(schema, { token: "" })).toEqual({});
    expect(coerce(schema, { token: "abc" })).toEqual({ token: "abc" });
  });

  it("非 secret 的 string 字段会把非字符串值强转为字符串", () => {
    expect(coerce(schema, { name: 123 })).toEqual({ name: "123" });
  });

  it("schema 里有但 patch 里没出现的字段不会被设置", () => {
    expect(coerce(schema, {})).toEqual({});
  });
});

// ─── aggregateConfigs — 多个 task usage 的 config 合并策略 ───────

describe("aggregateConfigs — 多 usage 配置合并", () => {
  const schema: ConfigField[] = [
    { key: "symbols", type: "string[]" },
    { key: "threshold", type: "number", min: 1 },
    { key: "pollIntervalSec", type: "number", min: 30 },
    { key: "verbose", type: "boolean" },
    { key: "city", type: "string" },
  ];

  it("string[] 字段：所有 usage 取并集", () => {
    const result = aggregateConfigs(
      schema,
      { symbols: [] },
      [{ symbols: ["AAPL", "NVDA"] }, { symbols: ["NVDA", "TSLA"] }]
    );
    expect(new Set(result.symbols as string[])).toEqual(
      new Set(["AAPL", "NVDA", "TSLA"])
    );
  });

  it("number 字段：取最小值（最敏感的阈值）", () => {
    const result = aggregateConfigs(
      schema,
      { threshold: 99 },
      [{ threshold: 5 }, { threshold: 2 }, { threshold: 8 }]
    );
    expect(result.threshold).toBe(2);
  });

  it("number 字段：合并后再被 schema.min 兜底", () => {
    // usage 给了 10，但 schema.min=30 所以最终落到 30
    const result = aggregateConfigs(
      schema,
      { pollIntervalSec: 600 },
      [{ pollIntervalSec: 10 }]
    );
    expect(result.pollIntervalSec).toBe(30);
  });

  it("boolean 字段：任一 usage 为 true 即为 true", () => {
    const result = aggregateConfigs(
      schema,
      { verbose: false },
      [{ verbose: false }, { verbose: true }]
    );
    expect(result.verbose).toBe(true);
  });

  it("string 字段：取第一个非空值", () => {
    const result = aggregateConfigs(
      schema,
      { city: "" },
      [{ city: "" }, { city: "NYC" }, { city: "LA" }]
    );
    expect(result.city).toBe("NYC");
  });

  it("usage 都没提供值时回退到 baseConfig", () => {
    const result = aggregateConfigs(
      schema,
      { symbols: ["BASE"], threshold: 5, city: "default" },
      [{}]
    );
    expect(result.symbols).toEqual(["BASE"]);
    expect(result.threshold).toBe(5);
    expect(result.city).toBe("default");
  });
});

// ─── ConnectorRuntime — 共享实例运行时 ────────────────────────────

const stockSchema: ConfigField[] = [
  { key: "symbols", type: "string[]", taskRequired: true },
  { key: "threshold", type: "number", min: 1 },
  { key: "pollIntervalSec", type: "number", min: 30 },
];

const weatherSchema: ConfigField[] = [
  { key: "country", type: "string", taskRequired: true },
  { key: "city", type: "string", taskRequired: true },
  { key: "pollIntervalSec", type: "number", min: 60 },
];

describe("ConnectorRuntime — 共享实例运行时", () => {
  it("addUsage 首次会创建实例并 start", async () => {
    const fake = makeFakeDescriptor({
      name: "stock",
      configSchema: stockSchema,
      defaults: { symbols: [], threshold: 3, pollIntervalSec: 300 },
    });
    const host = createMockHost({ descriptors: { stock: fake.descriptor } });
    const rt = new ConnectorRuntime(host.host);

    await rt.addUsage(
      makeUsage({ id: "u1", connector_name: "stock", params: { symbols: ["AAPL"] } })
    );

    expect(fake.records).toHaveLength(1);
    expect(fake.records[0]?.startCount).toBe(1);
    expect(rt.listInstances()).toEqual([
      { instanceKey: "stock", connectorName: "stock", usageCount: 1 },
    ]);
  });

  it("同一 identity 的两个 usage 共享实例并 hot-reload 合并后的 config", async () => {
    // stock 的 identity 字段集为空（symbols 是 string[]，threshold 是 number），
    // 所以两个 usage 的 instanceKey 都是 "stock" → 共享。
    const fake = makeFakeDescriptor({
      name: "stock",
      configSchema: stockSchema,
      defaults: { symbols: [], threshold: 3, pollIntervalSec: 300 },
    });
    const host = createMockHost({ descriptors: { stock: fake.descriptor } });
    const rt = new ConnectorRuntime(host.host);

    await rt.addUsage(
      makeUsage({ id: "u1", connector_name: "stock", params: { symbols: ["AAPL"], threshold: 3 } })
    );
    await rt.addUsage(
      makeUsage({ id: "u2", connector_name: "stock", params: { symbols: ["NVDA"], threshold: 1 } })
    );

    expect(fake.records).toHaveLength(1);
    const rec = fake.records[0]!;
    expect(rec.startCount).toBe(1);
    expect(rec.updateConfigCalls).toHaveLength(1);
    const merged = rec.updateConfigCalls[0]!;
    // symbols 取并集
    expect(new Set(merged.symbols as string[])).toEqual(new Set(["AAPL", "NVDA"]));
    // threshold 取最小（最敏感）
    expect(merged.threshold).toBe(1);
    expect(rt.listInstances()[0]?.usageCount).toBe(2);
  });

  it("identity 不同的 usage 各自起独立实例", async () => {
    // weather 的 identity 字段是 country + city（taskRequired & string & 非 secret），
    // 所以不同城市会得到不同的 instanceKey → 不共享。
    const fake = makeFakeDescriptor({
      name: "weather",
      configSchema: weatherSchema,
      defaults: { country: "", city: "", pollIntervalSec: 1800 },
    });
    const host = createMockHost({ descriptors: { weather: fake.descriptor } });
    const rt = new ConnectorRuntime(host.host);

    await rt.addUsage(
      makeUsage({
        id: "u1",
        connector_name: "weather",
        params: { country: "US", city: "NYC" },
      })
    );
    await rt.addUsage(
      makeUsage({
        id: "u2",
        connector_name: "weather",
        params: { country: "CN", city: "Beijing" },
      })
    );

    expect(fake.records).toHaveLength(2);
    expect(rt.listInstances().map((i) => i.instanceKey).sort()).toEqual([
      "weather:CN:Beijing",
      "weather:US:NYC",
    ]);
  });

  it("descriptor 没有 updateConfig 时 fallback 为 stop+restart", async () => {
    const fake = makeFakeDescriptor({
      name: "stock",
      configSchema: stockSchema,
      defaults: { symbols: [], threshold: 3, pollIntervalSec: 300 },
      noHotReload: true,
    });
    const host = createMockHost({ descriptors: { stock: fake.descriptor } });
    const rt = new ConnectorRuntime(host.host);

    await rt.addUsage(
      makeUsage({ id: "u1", connector_name: "stock", params: { symbols: ["AAPL"] } })
    );
    await rt.addUsage(
      makeUsage({ id: "u2", connector_name: "stock", params: { symbols: ["NVDA"] } })
    );

    // 第一个实例被 stop，第二个实例 start —— 即 stop+restart
    expect(fake.records).toHaveLength(2);
    expect(fake.records[0]?.stopCount).toBe(1);
    expect(fake.records[1]?.startCount).toBe(1);
  });

  it("removeUsage 移除最后一个 usage 时 stop 实例", async () => {
    const fake = makeFakeDescriptor({
      name: "stock",
      configSchema: stockSchema,
      defaults: { symbols: [], threshold: 3, pollIntervalSec: 300 },
    });
    const host = createMockHost({ descriptors: { stock: fake.descriptor } });
    const rt = new ConnectorRuntime(host.host);

    await rt.addUsage(
      makeUsage({ id: "u1", connector_name: "stock", params: { symbols: ["AAPL"] } })
    );
    await rt.removeUsage("u1");

    expect(fake.records[0]?.stopCount).toBe(1);
    expect(rt.listInstances()).toHaveLength(0);
    expect(rt.hasUsage("u1")).toBe(false);
  });

  it("removeUsage 后还有其他 usage 时仅 hot-reload", async () => {
    const fake = makeFakeDescriptor({
      name: "stock",
      configSchema: stockSchema,
      defaults: { symbols: [], threshold: 3, pollIntervalSec: 300 },
    });
    const host = createMockHost({ descriptors: { stock: fake.descriptor } });
    const rt = new ConnectorRuntime(host.host);

    await rt.addUsage(
      makeUsage({ id: "u1", connector_name: "stock", params: { symbols: ["AAPL"] } })
    );
    await rt.addUsage(
      makeUsage({ id: "u2", connector_name: "stock", params: { symbols: ["NVDA"] } })
    );
    const rec = fake.records[0]!;
    // 清掉之前 addUsage 触发的 updateConfig 记录，便于断言移除时重新合并
    rec.updateConfigCalls.length = 0;

    await rt.removeUsage("u2");

    expect(rec.stopCount).toBe(0);
    expect(rec.updateConfigCalls).toHaveLength(1);
    // symbols 集合里 NVDA 被剔掉，只剩 AAPL
    expect(rec.updateConfigCalls[0]?.symbols).toEqual(["AAPL"]);
    expect(rt.listInstances()[0]?.usageCount).toBe(1);
  });

  it("dyn_* 连接器永不共享，每个 usage 一个独立实例", async () => {
    const fake = makeFakeDescriptor({
      name: "dyn_my",
      configSchema: [{ key: "url", type: "string" }],
      defaults: { url: "" },
    });
    const host = createMockHost({ descriptors: { dyn_my: fake.descriptor } });
    const rt = new ConnectorRuntime(host.host);

    await rt.addUsage(
      makeUsage({ id: "u1", connector_name: "dyn_my", params: { url: "a" } })
    );
    await rt.addUsage(
      makeUsage({ id: "u2", connector_name: "dyn_my", params: { url: "a" } })
    );

    // 即使参数一模一样，dyn_* 也每个 usage 单独建实例
    expect(fake.records).toHaveLength(2);
    expect(rt.listInstances()).toHaveLength(2);
  });

  it("未知 descriptor 只 warn 不抛", async () => {
    const host = createMockHost();
    const rt = new ConnectorRuntime(host.host);

    await rt.addUsage(
      makeUsage({ id: "u1", connector_name: "no-such-connector", params: {} })
    );

    expect(rt.listInstances()).toHaveLength(0);
    expect(host.logs.some((l) => l.level === "warn" && l.message.includes("unknown connector"))).toBe(true);
  });

  it("实例 start 抛错时清理内部 bookkeeping", async () => {
    const fake = makeFakeDescriptor({
      name: "stock",
      configSchema: stockSchema,
      defaults: { symbols: [], threshold: 3, pollIntervalSec: 300 },
    });
    // 替换 create：让返回的实例 start() 抛错，验证 runtime 不会把它登记到 instances 表
    fake.descriptor.create = (config, ctx) => {
      const inst = makeFakeDescriptor({
        name: "stock",
        configSchema: stockSchema,
        defaults: {},
      }).descriptor.create(config, ctx);
      const wrapped = {
        ...inst,
        async start() {
          throw new Error("forced start failure");
        },
      };
      return wrapped;
    };
    const host = createMockHost({ descriptors: { stock: fake.descriptor } });
    const rt = new ConnectorRuntime(host.host);

    await rt.addUsage(
      makeUsage({ id: "u1", connector_name: "stock", params: { symbols: ["AAPL"] } })
    );

    // 没残留的实例 / usage 映射，下次 addUsage 仍能干净地重建
    expect(rt.listInstances()).toHaveLength(0);
    expect(rt.hasUsage("u1")).toBe(false);
    expect(host.logs.some((l) => l.level === "warn" && l.message.includes("failed to start"))).toBe(true);
  });

  it("stopAll 停掉所有运行中的实例", async () => {
    const fake = makeFakeDescriptor({
      name: "weather",
      configSchema: weatherSchema,
      defaults: { country: "", city: "", pollIntervalSec: 1800 },
    });
    const host = createMockHost({ descriptors: { weather: fake.descriptor } });
    const rt = new ConnectorRuntime(host.host);

    await rt.addUsage(
      makeUsage({ id: "u1", connector_name: "weather", params: { country: "US", city: "NYC" } })
    );
    await rt.addUsage(
      makeUsage({ id: "u2", connector_name: "weather", params: { country: "CN", city: "BJ" } })
    );

    await rt.stopAll();

    expect(fake.records.every((r) => r.stopCount === 1)).toBe(true);
    expect(rt.listInstances()).toHaveLength(0);
  });

  it("同一个 usage 重复 addUsage 是幂等的", async () => {
    const fake = makeFakeDescriptor({
      name: "stock",
      configSchema: stockSchema,
      defaults: { symbols: [], threshold: 3, pollIntervalSec: 300 },
    });
    const host = createMockHost({ descriptors: { stock: fake.descriptor } });
    const rt = new ConnectorRuntime(host.host);

    const usage = makeUsage({
      id: "u1",
      connector_name: "stock",
      params: { symbols: ["AAPL"] },
    });
    await rt.addUsage(usage);
    await rt.addUsage(usage);

    // 不应重复 start 也不应重复登记
    expect(fake.records).toHaveLength(1);
    expect(fake.records[0]?.startCount).toBe(1);
    expect(rt.listInstances()[0]?.usageCount).toBe(1);
  });

  it("正确合并三层配置：descriptor.defaults < cloud config < usage params", async () => {
    const fake = makeFakeDescriptor({
      name: "stock",
      configSchema: stockSchema,
      defaults: { symbols: ["DEFAULT"], threshold: 99, pollIntervalSec: 600 },
    });
    const host = createMockHost({
      descriptors: { stock: fake.descriptor },
      cloud: { stock: { threshold: 5, pollIntervalSec: 300 } },
    });
    const rt = new ConnectorRuntime(host.host);

    await rt.addUsage(
      makeUsage({ id: "u1", connector_name: "stock", params: { symbols: ["AAPL"] } })
    );

    const cfg = fake.records[0]!.configAtCreate;
    // usage 提供的 symbols 覆盖 default
    expect(cfg.symbols).toEqual(["AAPL"]);
    // cloud 覆盖 default（usage 没出现这两个字段）
    expect(cfg.threshold).toBe(5);
    expect(cfg.pollIntervalSec).toBe(300);
  });
});
