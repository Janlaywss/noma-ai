/**
 * Canonical list of built-in connectors the agent's `list_connectors` tool
 * surfaces to the LLM. Single source of truth — both the electron worker
 * (which actually executes the connector via its descriptor) and the
 * server eval harness (which mocks the response) read from this same data.
 *
 * Keep this in sync with the descriptors under
 * `apps/desktop/electron/src/worker/connectors/*.ts` — the JSON drives the
 * agent's view, the descriptors drive the runtime. A drift means the
 * agent claims a connector with params it doesn't accept.
 */
import data from "./builtin-connectors.json";

export type ConfigFieldType = "string" | "number" | "boolean" | "string[]";

export interface ConfigField {
  key: string;
  type: ConfigFieldType;
  secret?: boolean;
  taskRequired?: boolean;
  min?: number;
  max?: number;
}

export interface BuiltinConnector {
  name: string;
  label: string;
  description: string;
  configSchema: ConfigField[];
  defaults: Record<string, unknown>;
}

export const BUILTIN_CONNECTORS: ReadonlyArray<BuiltinConnector> =
  data as BuiltinConnector[];

/**
 * Render the connector list in the exact shape the LLM sees as the
 * `list_connectors` tool result. Includes each connector's
 * configSchema so the model knows which params to pass when claiming
 * one in `scheduleTask`.
 */
export function formatBuiltinConnectorsList(
  connectors: ReadonlyArray<BuiltinConnector> = BUILTIN_CONNECTORS
): string {
  const items = connectors
    .map((c) => {
      const fields = c.configSchema
        .map((f) => {
          const flags = [
            f.taskRequired ? "taskRequired" : "",
            f.secret ? "secret" : "",
          ]
            .filter(Boolean)
            .join(",");
          const flagSuffix = flags ? ` [${flags}]` : "";
          const defaultValue =
            f.key in c.defaults ? `=${JSON.stringify(c.defaults[f.key])}` : "";
          return `      - ${f.key}: ${f.type}${defaultValue}${flagSuffix}`;
        })
        .join("\n");
      return `- \`${c.name}\` — ${c.label}: ${c.description}\n    params:\n${fields}`;
    })
    .join("\n");
  return `### Built-in connectors\n${items}`;
}
