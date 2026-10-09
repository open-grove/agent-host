import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CodexAgent } from "@open-grove/agent-host/codex";
import { FileBindingStore } from "@open-grove/agent-host";

/** This product owns its document, approvals and UI. No OpenGrove concepts. */
export async function createEditor({
  directory,
  command = "codex",
  approve,
  ask,
  args,
  bindings,
  thread = {},
}) {
  const cwd = resolve(directory);
  await mkdir(cwd, { recursive: true });
  const document = join(cwd, "document.txt");
  try {
    await writeFile(document, "An example document.\n", { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const agent = new CodexAgent({
    command,
    args,
    bindings: bindings ?? new FileBindingStore(join(cwd, ".agent-host")),
  });
  const tools = [
    {
      name: "edit_document",
      description:
        "Replace the example document after asking the product user for approval.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      async execute(input, context) {
        if (
          !input ||
          typeof input.text !== "string" ||
          input.text.length > 100_000
        )
          throw new Error("Invalid document text");
        const allowed = await approve(
          { title: "Replace document.txt", text: input.text },
          context.signal,
        );
        context.signal.throwIfAborted();
        if (!allowed)
          return {
            success: false,
            contentItems: [
              {
                type: "inputText",
                text: "The user rejected this edit. Do not change the document.",
              },
            ],
          };
        await writeFile(document, input.text, "utf8");
        return {
          success: true,
          contentItems: [{ type: "inputText", text: "Document saved." }],
        };
      },
    },
  ];
  return {
    document,
    read: () => readFile(document, "utf8"),
    close: () => agent.close(),
    async *run(input, { signal, sessionId = "example-editor" } = {}) {
      yield* agent.run({
        sessionId,
        cwd,
        input,
        signal,
        tools,
        instructions:
          "You help edit one example document. Use edit_document for every edit; the product handles approval. Do not use shell or file tools to modify it. Respect rejected edits. Answer concisely.",
        context: `Current document contents:\n${await readFile(document, "utf8")}`,
        thread: {
          sandbox: "read-only",
          approvalPolicy: "on-request",
          ...thread,
        },
        async onRequest(request, context) {
          if (
            request.method === "item/commandExecution/requestApproval" ||
            request.method === "item/fileChange/requestApproval"
          )
            return {
              decision: (await approve(request, context.signal))
                ? "accept"
                : "decline",
            };
          if (request.method === "item/tool/requestUserInput")
            return {
              answers:
                (await ask?.(request.params.questions, context.signal)) ?? {},
            };
          if (request.method === "mcpServer/elicitation/request")
            return { action: "decline" };
          return undefined;
        },
      });
    },
  };
}
