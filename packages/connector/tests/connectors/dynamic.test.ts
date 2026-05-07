import { describe, it, expect, afterEach, vi } from "vitest";
import { createDynamicConnector } from "../../src/app/dynamic.js";
import { createMockContext } from "../helpers/mock-context.js";
import type { Connector } from "../../src/types.js";

let conn: Connector | null = null;

afterEach(async () => {
  if (conn) {
    await conn.stop();
    conn = null;
  }
  vi.useRealTimers();
});

describe("dynamic connector — 用户自定义 JS 连接器", () => {
  it("用户代码没返回包含 poll() 的对象时抛错", () => {
    // 这是 create() 阶段的硬错误，必须 fail-fast，不能等到 start() 才发现
    const { ctx } = createMockContext();
    expect(() =>
      createDynamicConnector("dyn_bad", `({})`, { pollIntervalSec: 60 }, ctx)
    ).toThrow(/poll\(\)/);
  });

  it("首次 poll 只 prime seen 集合，不转发事件", async () => {
    // 用户代码自己用 ctx.seen / markSeen 做去重，runtime 把首次 poll 的 emitEvent 丢弃
    const code = `
      ({
        async poll(_cfg, ctx) {
          const items = ['a', 'b'];
          for (const id of items) {
            if (!ctx.seen(id)) {
              ctx.markSeen(id);
              ctx.emitEvent({ type: 'item', payload: { id } });
            }
          }
        }
      })
    `;
    const { ctx, events } = createMockContext();
    conn = createDynamicConnector("dyn_test", code, { pollIntervalSec: 60 }, ctx);
    await conn.start();

    expect(events).toHaveLength(0);
    const status = conn.status() as { primed: boolean; seenCount: number };
    expect(status.primed).toBe(true);
    expect(status.seenCount).toBe(2);
  });

  it("第二次起 poll 通过 ctx.emitEvent 转发用户代码的事件", async () => {
    // 用户代码运行在 new Function 沙箱里，闭包变量无法跨 poll 调用保留 →
    // 借 globalThis 计数器观察「这是第几次 poll」，让两次 poll 返回不同 items
    const code = `
      ({
        async poll(_cfg, ctx) {
          const all = [['a'], ['a', 'b']];
          const idx = (globalThis.__dynCall ?? 0);
          globalThis.__dynCall = idx + 1;
          for (const id of all[idx] ?? []) {
            if (!ctx.seen(id)) {
              ctx.markSeen(id);
              ctx.emitEvent({ type: 'item', payload: { id } });
            }
          }
        }
      })
    `;
    (globalThis as Record<string, unknown>).__dynCall = 0;

    vi.useFakeTimers();
    const { ctx, events } = createMockContext();
    conn = createDynamicConnector("dyn_test", code, { pollIntervalSec: 60 }, ctx);
    await conn.start(); // 首次 priming，被 runtime 静默吞掉

    // 推进定时器触发第二次 poll：这次应当只 emit 新增的 'b'
    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(events).toHaveLength(1);
    expect(events[0]?.payload?.id).toBe("b");
  });

  it("用户代码抛错时只 warn 不 crash", async () => {
    const code = `({ async poll() { throw new Error('boom'); } })`;
    const { ctx, events, logs } = createMockContext();
    conn = createDynamicConnector("dyn_bad", code, { pollIntervalSec: 60 }, ctx);
    // 用户代码不可信，runtime 必须把错误吃掉，否则一个坏插件会拖垮整个 worker
    await expect(conn.start()).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
    expect(logs.some((l) => l.level === "warn" && l.message.includes("poll failed"))).toBe(true);
  });

  it("pollIntervalSec 下限 30 秒（防止用户配置过小拖垮系统）", async () => {
    const code = `({ async poll() {} })`;
    const { ctx } = createMockContext();
    conn = createDynamicConnector("dyn_x", code, { pollIntervalSec: 5 }, ctx);
    await conn.start();
    const status = conn.status() as { pollIntervalSec: number };
    expect(status.pollIntervalSec).toBe(30);
  });

  it("沙箱注入 fetch / console / URL / URLSearchParams 给用户代码", async () => {
    // 这是约定的「最小可用 globals」，扩大范围前需要重新评估安全风险
    const code = `
      ({
        async poll() {
          if (typeof fetch !== 'function') throw new Error('no fetch');
          if (!URL || !URLSearchParams) throw new Error('no URL helpers');
          if (typeof console.log !== 'function') throw new Error('no console');
        }
      })
    `;
    const { ctx, logs } = createMockContext();
    conn = createDynamicConnector("dyn_x", code, { pollIntervalSec: 60 }, ctx);
    await expect(conn.start()).resolves.toBeUndefined();
    // 没有 warn 说明 sandbox 提供了上述所有 globals
    expect(logs.some((l) => l.level === "warn" && l.message.includes("poll failed"))).toBe(false);
  });
});
