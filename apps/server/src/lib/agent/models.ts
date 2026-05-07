import { openrouter } from "@openrouter/ai-sdk-provider";
import { resolveModelId } from "@noma/shared";

export {
  MODELS,
  DEFAULT_MODEL_ID,
  resolveModelId,
  type ModelOption,
} from "@noma/shared";

export function modelFor(id: string) {
  const resolved = resolveModelId(id);
  return openrouter(resolved, { reasoning: { effort: "high" } });
}
