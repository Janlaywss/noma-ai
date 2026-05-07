import { openrouter } from "@openrouter/ai-sdk-provider";
import { resolveModelId } from "@noma/shared";

export {
  MODELS,
  resolveModelId,
  type ModelOption,
} from "@noma/shared";

export function modelFor(id: string) {
  const resolved = resolveModelId(id);
  if (!resolved) throw new Error(`Invalid model ID: ${id}`);
  return openrouter(resolved, { reasoning: { effort: "high" } });
}
