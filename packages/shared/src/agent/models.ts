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
    id: "anthropic/claude-sonnet-4",
    label: "Claude Sonnet 4",
    hint: "Anthropic · balanced",
    contextWindow: 200_000,
  },
] as const;

export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

/** Validate an incoming model id. Returns `null` if empty/missing.
 *  Accepts any non-empty string — actual model validation is done by OpenRouter. */
export function resolveModelId(id: unknown): string | null {
  if (typeof id !== "string" || !id) return null;
  return id;
}
