import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ProductTool, InteractionContext, AgentEvent } from "./agent.js";
import type { AsyncEventQueue } from "./async-event-queue.js";
import type { HostToolBridge } from "./acp/tools.js";
import type { JsonObject, JsonValue } from "./types.js";
import { abortable } from "./abortable.js";
export function productToolBridge(
  tools: ProductTool[],
  context: InteractionContext,
  queue: Pick<AsyncEventQueue<AgentEvent>, "push">,
): HostToolBridge {
  const calls = new Map<
    string,
    { signature: string; result: Promise<CallToolResult> }
  >();
  return {
    descriptors: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: object(tool.inputSchema),
    })),
    call: async (name, input, callId) => {
      const signature = JSON.stringify({ name, input });
      const old = calls.get(callId);
      if (old) {
        if (old.signature !== signature) throw new Error("tool_call_id_reused");
        return old.result;
      }
      const result = (async (): Promise<CallToolResult> => {
        const tool = tools.find((tool) => tool.name === name);
        context.signal.throwIfAborted();
        if (!tool?.execute) throw new Error("tool_not_available");
        queue.push({
          type: "tool.started",
          runId: context.runId,
          callId,
          tool: name,
          input: input as JsonValue,
        });
        const result = await abortable(
          tool.execute(input as JsonValue, { ...context, callId }),
          context.signal,
        ).catch((error) => ({
          success: false,
          contentItems: [{ type: "inputText" as const, text: String(error) }],
        }));
        queue.push({
          type: "tool.finished",
          runId: context.runId,
          callId,
          tool: name,
          result,
        });
        return {
          isError: !result.success,
          content: result.contentItems.map((item) =>
            item.type === "inputText"
              ? { type: "text" as const, text: item.text }
              : {
                  type: "resource_link" as const,
                  uri: item.imageUrl,
                  name: "image",
                },
          ),
        };
      })();
      calls.set(callId, { signature, result });
      return result;
    },
  };
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
