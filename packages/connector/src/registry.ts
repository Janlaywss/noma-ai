import type { ConnectorDescriptor } from "./types.js";
import { githubDescriptor } from "./app/github.js";
import { gmailDescriptor } from "./app/gmail.js";
import { jin10Descriptor } from "./app/jin10.js";
import { larkDescriptor } from "./app/lark.js";
import { stockDescriptor } from "./app/stock.js";
import { weatherDescriptor } from "./app/weather.js";
import { flightDescriptor } from "./app/flight.js";

/**
 * Static catalog of built-in connector descriptors. Keep this list short
 * and obvious — adding a new connector kind is a single import + entry.
 *
 * The host (typically the desktop worker) turns these descriptors into
 * running `Connector` instances per task claim. The registry itself never
 * holds runtime state.
 *
 * Dynamic (`dyn_*`) connectors are NOT here — they live in the host's
 * database and are loaded via the host's own loader, which then calls
 * `createDynamicConnector()` from `./dynamic.js`.
 */
export const CONNECTOR_REGISTRY: Record<
  string,
  ConnectorDescriptor<Record<string, unknown>>
> = {
  github: githubDescriptor as ConnectorDescriptor<Record<string, unknown>>,
  gmail: gmailDescriptor as ConnectorDescriptor<Record<string, unknown>>,
  lark: larkDescriptor as ConnectorDescriptor<Record<string, unknown>>,
  stock: stockDescriptor as ConnectorDescriptor<Record<string, unknown>>,
  jin10: jin10Descriptor as ConnectorDescriptor<Record<string, unknown>>,
  weather: weatherDescriptor as ConnectorDescriptor<Record<string, unknown>>,
  flight: flightDescriptor as ConnectorDescriptor<Record<string, unknown>>,
};

export function builtinConnectorNames(): string[] {
  return Object.keys(CONNECTOR_REGISTRY);
}

/**
 * Connectors that are visible in the UI. Other connectors remain in the
 * registry (and can still be used programmatically) but won't appear in
 * the desktop front-end.
 */
export const FEATURED_CONNECTORS: string[] = ["jin10", "gmail", "lark"];

export function featuredConnectorNames(): string[] {
  return FEATURED_CONNECTORS.filter((name) => name in CONNECTOR_REGISTRY);
}
