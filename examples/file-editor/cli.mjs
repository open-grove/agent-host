import { createInterface } from "node:readline/promises";
import { createEditor } from "./editor.mjs";

const ui = createInterface({ input: process.stdin, output: process.stdout });
let active;
const editor = await createEditor({
  directory: process.argv[2] ?? ".local/editor",
  command: process.env.AGENT_HOST_CODEX ?? "codex",
  approve: async (request, signal) =>
    (
      await ui.question(`${JSON.stringify(request, null, 2)}\nAllow? [y/N] `, {
        signal,
      })
    ).toLowerCase() === "y",
  ask: async (questions, signal) => {
    const answers = {};
    for (const question of questions)
      answers[question.id] = {
        answers: [await ui.question(`${question.question} `, { signal })],
      };
    return answers;
  },
});
ui.on("SIGINT", () => {
  if (active) active.abort();
  else ui.close();
});
try {
  console.log(
    `Document: ${editor.document}\nType /quit to exit. Ctrl-C stops the current turn.`,
  );
  while (!ui.closed) {
    const input = await ui.question("You: ");
    if (input === "/quit") break;
    if (!input.trim()) continue;
    active = new AbortController();
    for await (const event of editor.run(input, { signal: active.signal })) {
      if (event.type === "assistant.delta") process.stdout.write(event.text);
      if (event.type === "session.bound")
        console.log(
          `[${event.resumed ? "Resumed" : "Created"} native session ${event.threadId}]`,
        );
      if (event.type === "turn.finished")
        console.log(
          `\n[${event.outcome.status}${event.outcome.error ? `: ${event.outcome.error}` : ""}]`,
        );
    }
    active = undefined;
  }
} finally {
  await editor.close();
  ui.close();
}
