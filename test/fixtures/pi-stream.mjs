import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export const model = {
  id: "fixture",
  name: "Fixture",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};
export function fixture(observed, toolName = "edit") {
  return (_, context) => {
    observed.push(context);
    const tool = context.messages.at(-1)?.role === "toolResult";
    const call =
      !tool && JSON.stringify(context.messages.at(-1)).includes("call edit");
    const message = {
      role: "assistant",
      content: call
        ? [
            {
              type: "toolCall",
              id: "edit-1",
              name: toolName,
              arguments: { text: "CEDAR" },
            },
          ]
        : [
            {
              type: "text",
              text: tool
                ? JSON.stringify(context.messages.at(-1).content)
                : "Native reply",
            },
          ],
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: call ? "toolUse" : "stop",
      timestamp: Date.now(),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
    });
    return stream;
  };
}
