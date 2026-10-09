import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/** An SDK seam fixture: MCP calls still cross the actual SDK server protocol. */
export function createClaudeQueryFixture(observed = []) {
  return ({ prompt, options }) => {
    observed.push(options);
    let closed = false;
    return {
      close() {
        closed = true;
      },
      async setPermissionMode(mode) {
        observed.push({ activation: mode });
        if (mode === "auto") throw new Error("auto_unavailable");
      },
      async *[Symbol.asyncIterator]() {
        const session_id = options.resume ?? options.sessionId;
        yield {
          type: "system",
          subtype: "init",
          session_id,
          permissionMode: "default",
          model: "fixture",
        };
        let text;
        if (typeof prompt === "string") text = prompt;
        else {
          const messages = await Array.fromAsync(prompt);
          text = messages
            .map((message) =>
              typeof message.message.content === "string"
                ? message.message.content
                : JSON.stringify(message.message.content),
            )
            .join("\n");
        }
        if (text.includes("fixture tool")) {
          const [left, right] = InMemoryTransport.createLinkedPair();
          const client = new Client({ name: "fixture", version: "1" });
          await options.mcpServers.agent_host.instance.connect(right);
          await client.connect(left);
          try {
            const { tools } = await client.listTools();
            const result = await client.callTool({
              name: tools[0].name,
              arguments: { text: "Saved via Claude" },
            });
            text = JSON.stringify(result);
          } finally {
            await client.close();
          }
        } else if (text.includes("fixture permission"))
          text = JSON.stringify(
            await options.canUseTool(
              "Bash",
              { command: "echo probe" },
              {
                signal: options.abortController.signal,
                toolUseID: "native-tool",
              },
            ),
          );
        else if (text.includes("fixture question"))
          text = JSON.stringify(
            await options.onElicitation(
              {
                mode: "form",
                message: "Title?",
                requestedSchema: {
                  type: "object",
                  properties: { title: { type: "string" } },
                },
              },
              { signal: options.abortController.signal },
            ),
          );
        if (closed) throw new Error("query_closed");
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text },
          },
          session_id,
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: text,
          session_id,
        };
      },
    };
  };
}
