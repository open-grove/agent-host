import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Models,
  type Context as NativeModelContext,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
export function bridgePiStream(
  streamFn: StreamFn,
  model: Parameters<Models["streamSimple"]>[0],
  context: NativeModelContext,
  options: Parameters<Models["streamSimple"]>[2],
) {
  const result = streamFn(model, context, options);
  if (Symbol.asyncIterator in result) return result;
  const output = createAssistantMessageEventStream();
  void (async () => {
    try {
      const stream = await result;
      for await (const event of stream) output.push(event);
      output.end(await stream.result());
    } catch (error) {
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        model: model.id,
        provider: model.provider,
        stopReason: "error",
        timestamp: Date.now(),
        errorMessage: error instanceof Error ? error.message : String(error),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      output.push({ type: "error", reason: "error", error: message });
      output.end(message);
    }
  })();
  return output;
}
