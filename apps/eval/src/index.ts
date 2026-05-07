import { builtinConnectorNames, CONNECTOR_REGISTRY } from "@noma/connector";
import type { AgentRunEvent } from "@noma/event-agent";

const requiredConnectors = ["github", "gmail", "lark", "stock", "jin10"];
const names = builtinConnectorNames();
const missing = requiredConnectors.filter((name) => !names.includes(name));

if (missing.length > 0) {
  throw new Error(`缺少内置连接器: ${missing.join(", ")}`);
}

const mockRunEvent: AgentRunEvent = {
  kind: "done",
  cumulative: "eval smoke completed",
};

const report = {
  status: "ok",
  checkedAt: new Date(0).toISOString(),
  eventAgentContract: mockRunEvent.kind,
  connectors: names.map((name) => {
    const descriptor = CONNECTOR_REGISTRY[name];
    return {
      name,
      label: descriptor.label,
      configFields: descriptor.configSchema.length,
      tools: descriptor.tools?.length ?? 0,
    };
  }),
};

console.log(JSON.stringify(report, null, 2));
