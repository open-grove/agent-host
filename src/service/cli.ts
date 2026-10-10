#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { startAgentHostServer } from "./server.js";
import {
  createNativeRuntime,
  type NativeRuntimeConfig,
} from "./native-runtimes.js";
import { idSchema } from "./protocol.js";

const profileSchema = z
  .object({
    id: idSchema,
    kernel: z.enum([
      "codex",
      "claude",
      "pi",
      "opencode",
      "kimi",
      "hermes",
      "openclaw",
    ]),
    cwd: z.string().min(1),
    model: z.string().optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    thread: z.record(z.string(), z.json()).optional(),
    turn: z.record(z.string(), z.json()).optional(),
    gatewayUrl: z.url().optional(),
    gatewayTokenEnv: z.string().optional(),
    provider: z.string().optional(),
    effort: z.string().optional(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    const allowed = {
      codex: ["command", "args", "env", "thread", "turn"],
      claude: ["command", "env"],
      opencode: ["command", "args", "env", "effort"],
      kimi: ["command", "args", "env", "effort"],
      pi: [],
      hermes: ["command", "args", "env", "provider", "effort"],
      openclaw: ["gatewayUrl", "gatewayTokenEnv"],
    }[profile.kernel];
    for (const key of Object.keys(profile))
      if (!["id", "kernel", "cwd", "model", ...allowed].includes(key))
        ctx.addIssue({
          code: "custom",
          message: `${key} is not supported by this ${profile.kernel} CLI profile`,
        });
    if (profile.kernel === "hermes" && !profile.command)
      ctx.addIssue({
        code: "custom",
        message: "Hermes requires its gateway command and arguments",
      });
    if (profile.kernel === "openclaw" && !profile.gatewayUrl)
      ctx.addIssue({ code: "custom", message: "OpenClaw requires gatewayUrl" });
    if (
      profile.gatewayUrl &&
      !["ws:", "wss:"].includes(new URL(profile.gatewayUrl).protocol)
    )
      ctx.addIssue({
        code: "custom",
        message: "OpenClaw gatewayUrl must use ws or wss",
      });
    if (profile.gatewayTokenEnv && !process.env[profile.gatewayTokenEnv])
      ctx.addIssue({
        code: "custom",
        message: "Configured Gateway token environment variable is empty",
      });
    if (profile.kernel === "pi" && !profile.model)
      ctx.addIssue({ code: "custom", message: "Pi requires provider/model" });
  });
const configSchema = z
  .object({
    stateDirectory: z.string().default(".agent-host"),
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(37420),
    allowedOrigins: z.array(z.string().url()).default([]),
    workspaceFiles: z.boolean().default(false),
    runtimes: z.array(profileSchema).min(1),
  })
  .strict();

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      "token-file": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: agent-host serve --config host.json [--host 127.0.0.1] [--port 37420] [--token-file path]\nThe service uses AGENT_HOST_TOKEN or a private token file. Native credentials stay on the server.",
    );
    return;
  }
  if (positionals.length !== 1 || positionals[0] !== "serve" || !values.config)
    throw new Error("Usage: agent-host serve --config host.json");
  const filename = resolve(values.config);
  const config = configSchema.parse(
    JSON.parse(await readFile(filename, "utf8")),
  );
  const stateDirectory = resolve(dirname(filename), config.stateDirectory);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const tokenFile = values["token-file"]
    ? resolve(values["token-file"])
    : join(stateDirectory, "token");
  let token = process.env.AGENT_HOST_TOKEN;
  if (!token) {
    try {
      token = (await readFile(tokenFile, "utf8")).trim();
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        values["token-file"]
      )
        throw error;
      token = randomBytes(32).toString("hex");
      try {
        await writeFile(tokenFile, `${token}\n`, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        token = (await readFile(tokenFile, "utf8")).trim();
      }
    }
  }
  const runtimes = config.runtimes.map((profile) => {
    const base = {
      id: profile.id,
      kernel: profile.kernel,
      cwd: resolve(dirname(filename), profile.cwd),
      model: profile.model,
    };
    const options = {
      command: profile.command,
      args: profile.args,
      env: profile.env,
    };
    let native: NativeRuntimeConfig;
    switch (profile.kernel) {
      case "codex":
        native = {
          ...base,
          kernel: "codex",
          options,
          thread: profile.thread,
          turn: profile.turn,
        };
        break;
      case "claude":
        native = {
          ...base,
          kernel: "claude",
          options: { command: profile.command, env: profile.env },
        };
        break;
      case "opencode":
      case "kimi":
        native = {
          ...base,
          kernel: profile.kernel,
          options,
          effort: profile.effort,
        };
        break;
      case "pi":
        native = { ...base, kernel: "pi" };
        break;
      case "hermes":
        native = {
          ...base,
          kernel: "hermes",
          options: { ...options, command: profile.command! },
          provider: profile.provider,
          reasoningEffort: profile.effort,
        };
        break;
      case "openclaw":
        native = {
          ...base,
          kernel: "openclaw",
          options: {
            url: profile.gatewayUrl!,
            token: profile.gatewayTokenEnv
              ? process.env[profile.gatewayTokenEnv]
              : undefined,
          },
        };
        break;
    }
    return createNativeRuntime(native, stateDirectory);
  });
  const host = await startAgentHostServer({
    ...config,
    stateDirectory,
    runtimes,
    token,
    host: values.host ?? config.host,
    port: values.port
      ? z.coerce.number().int().min(0).max(65535).parse(values.port)
      : config.port,
  });
  console.log(`Agent Host listening at ${host.url}`);
  console.log(
    process.env.AGENT_HOST_TOKEN
      ? "Authentication: AGENT_HOST_TOKEN"
      : `Authentication token file: ${tokenFile}`,
  );
  console.log(`State directory: ${stateDirectory}`);
  const stop = () => {
    const deadline = setTimeout(() => {
      console.error("Agent Host shutdown timed out");
      process.exit(1);
    }, 15_000);
    deadline.unref();
    void host.close().then(
      () => {
        clearTimeout(deadline);
      },
      (error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
