import { oneModelStep } from "./llm-step.js";
import type {
  AgentHooks,
  AgentRunContext,
  AgentSystemPromptKind,
  AgentToolCall,
  AgentToolResult,
  AgentToolSet,
  LlmStreamTransport,
} from "./types.js";

export type AgentRuntimeOptions = {
  transport: LlmStreamTransport;
  tools: AgentToolSet;
  hooks: AgentHooks;
  maxTurns?: number;
  logger?: Pick<Console, "error">;
};

export type RunTurnInput = {
  runId: string;
  text: string;
  model?: string;
  systemPromptKind?: AgentSystemPromptKind;
};

const DEFAULT_MAX_TURNS = 8;

export class AgentRuntime {
  private readonly maxTurns: number;
  private readonly transport: LlmStreamTransport;
  private readonly tools: AgentToolSet;
  private readonly hooks: AgentHooks;
  private readonly logger: Pick<Console, "error">;

  constructor(options: AgentRuntimeOptions) {
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.transport = options.transport;
    this.tools = options.tools;
    this.hooks = options.hooks;
    this.logger = options.logger ?? console;
  }

  async runTurn(input: RunTurnInput): Promise<void> {
    const context: AgentRunContext = {
      runId: input.runId,
      model: input.model ?? "",
    };

    try {
      await this.hooks.appendUserMessage?.({
        ...context,
        content: input.text,
      });

      const messages = await this.hooks.loadMessages(context);
      const snapshots = new Map<
        string,
        {
          toolCallId: string;
          toolName: string;
          state: "input-available" | "output-available" | "output-error";
          input?: Record<string, unknown>;
          output?: unknown;
          errorText?: string;
        }
      >();
      let cumulative = "";

      for (let turn = 0; turn < this.maxTurns; turn++) {
        const abortSignal = this.hooks.getAbortSignal?.(context);
        if (abortSignal?.aborted) return;

        const outcome = await oneModelStep({
          transport: this.transport,
          model: context.model,
          systemPromptKind: input.systemPromptKind,
          messages,
          toolSchemas: this.tools.listSchemas(),
          abortSignal,
          onTextDelta: (delta) => {
            cumulative += delta;
            void this.publish(context, {
              kind: "text",
              delta,
              cumulative,
            });
          },
          onToolCall: (call) => {
            const snapshot = {
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              state: "input-available" as const,
              input: call.input,
            };
            snapshots.set(call.toolCallId, snapshot);
            void this.publish(context, {
              kind: "tool",
              payload: snapshot,
            });
          },
          onToolResult: (result) => {
            const snapshot = snapshots.get(result.toolCallId);
            if (!snapshot) return;
            const next = {
              ...snapshot,
              state: "output-available" as const,
              output: result.output,
            };
            snapshots.set(result.toolCallId, next);
            void this.publish(context, {
              kind: "tool",
              payload: next,
            });
          },
        });

        if (outcome.kind === "error") {
          await this.fail(context, outcome.message);
          return;
        }

        if (outcome.kind === "done" && outcome.toolCalls.length === 0) break;

        const pendingCalls = outcome.toolCalls.filter(
          (c) => !outcome.serverOutputs.has(c.toolCallId)
        );

        const assistantContent = this.assistantContent(
          outcome.text,
          outcome.toolCalls
        );
        messages.push({ role: "assistant", content: assistantContent });

        const localResults = await Promise.all(
          pendingCalls.map(async (call): Promise<AgentToolResult> => {
            const output = await this.tools.execute(call);
            const snapshot = snapshots.get(call.toolCallId);
            if (snapshot) {
              const next = {
                ...snapshot,
                state: "output-available" as const,
                output,
              };
              snapshots.set(call.toolCallId, next);
              await this.publish(context, {
                kind: "tool",
                payload: next,
              });
            }
            return { toolCallId: call.toolCallId, toolName: call.toolName, output };
          })
        );

        const allResults = outcome.toolCalls.map((call) => {
          const serverOutput = outcome.serverOutputs.get(call.toolCallId);
          if (serverOutput !== undefined) {
            return {
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: serverOutput,
            };
          }
          return localResults.find((r) => r.toolCallId === call.toolCallId)!;
        });

        messages.push({
          role: "tool",
          content: allResults.map((r) => ({
            type: "tool-result",
            toolCallId: r.toolCallId,
            toolName: r.toolName,
            output: { type: "text", value: r.output },
          })),
        });
      }

      await this.hooks.finalizeAssistantMessage?.({
        ...context,
        content: cumulative,
      });
      await this.hooks.onFinish?.({ ...context, cumulative });
    } catch (err) {
      if (this.hooks.getAbortSignal?.(context)?.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      await this.fail(context, message);
    }
  }

  private assistantContent(text: string, toolCalls: AgentToolCall[]) {
    const content: Array<
      | { type: "text"; text: string }
      | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
    > = [];
    if (text.length > 0) content.push({ type: "text", text });
    for (const call of toolCalls) {
      content.push({
        type: "tool-call",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
      });
    }
    return content;
  }

  private async publish(
    context: AgentRunContext,
    event: Parameters<NonNullable<AgentHooks["publish"]>>[0]["event"]
  ): Promise<void> {
    try {
      await this.hooks.publish?.({ ...context, event });
    } catch (err) {
      this.logger.error("[agent] publish hook failed:", err);
    }
  }

  private async fail(context: AgentRunContext, message: string): Promise<void> {
    await this.publish(context, { kind: "error", message });
    await this.hooks.onError?.({ ...context, message });
  }
}
