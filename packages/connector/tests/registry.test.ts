import { describe, it, expect } from "vitest";
import {
  CONNECTOR_REGISTRY,
  builtinConnectorNames,
} from "../src/registry.js";

describe("CONNECTOR_REGISTRY — 内置注册表契约", () => {
  it("内置连接器列表与预期一致", () => {
    // 改动这个列表前先确认 worker / UI 都跟得上 —— 注册表是对外契约
    expect(builtinConnectorNames().sort()).toEqual([
      "flight",
      "github",
      "gmail",
      "jin10",
      "lark",
      "stock",
      "weather",
    ]);
  });

  it("descriptor.name 与注册表 key 一致", () => {
    for (const [key, descriptor] of Object.entries(CONNECTOR_REGISTRY)) {
      expect(descriptor.name).toBe(key);
    }
  });

  it("每个 descriptor 都暴露 label / description / schema / defaults / create()", () => {
    for (const descriptor of Object.values(CONNECTOR_REGISTRY)) {
      expect(typeof descriptor.label).toBe("string");
      expect(typeof descriptor.description).toBe("string");
      expect(Array.isArray(descriptor.configSchema)).toBe(true);
      expect(typeof descriptor.defaults).toBe("object");
      expect(typeof descriptor.create).toBe("function");
    }
  });

  it("schema 字段的 type 必须是已知的四种之一", () => {
    const validTypes = new Set(["string", "number", "boolean", "string[]"]);
    for (const descriptor of Object.values(CONNECTOR_REGISTRY)) {
      for (const f of descriptor.configSchema) {
        expect(validTypes.has(f.type)).toBe(true);
      }
    }
  });

  it("除 jin10（纯全局 feed）外，每个连接器至少有一个 taskRequired 字段", () => {
    // jin10 不需要任何 task 级参数，所有用户共享同一份 feed；
    // 其他连接器都得有 taskRequired 字段才能区分用户/任务
    for (const [name, descriptor] of Object.entries(CONNECTOR_REGISTRY)) {
      const hasTaskRequired = descriptor.configSchema.some((f) => f.taskRequired);
      if (name === "jin10") {
        expect(hasTaskRequired).toBe(false);
      } else {
        expect(hasTaskRequired).toBe(true);
      }
    }
  });
});
