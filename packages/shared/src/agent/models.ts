/**
 * Curated set of models exposed in the chat header dropdown.
 * Pure data + validation — consumed by both the web dropdown and the
 * server worker. The server wraps this with a `modelFor()` helper that
 * instantiates the matching provider instance.
 */
export interface ModelOption {
  id: string;
  label: string;
  hint: string;
  contextWindow: number;
}

export const MODELS: readonly ModelOption[] = [
  {
    id: "anthropic/claude-sonnet-4-20250514",
    label: "Claude Sonnet 4",
    hint: "Anthropic · balanced",
    contextWindow: 200_000,
  },
] as const;

export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

export const DEFAULT_MODEL_ID = MODELS[0].id;

const VALID_IDS = new Set(MODELS.map((m) => m.id));

/** Validate an incoming model id; fall back to the default if unknown. */
export function resolveModelId(id: unknown): string {
  if (typeof id !== "string") return DEFAULT_MODEL_ID;
  if (VALID_IDS.has(id) || id.startsWith("@preset/")) return id;
  return DEFAULT_MODEL_ID;
}
