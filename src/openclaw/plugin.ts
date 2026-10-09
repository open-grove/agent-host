import type { JsonObject } from "../types.js";

interface NativeToolContext {
  sessionKey?: string;
  assertInvocationCurrent(): void;
}
interface NativeTool {
  name: string;
  label: string;
  description: string;
  parameters: JsonObject;
  execute(
    callId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<{ content: unknown[]; details?: unknown }>;
}
interface GatewayRequest {
  params?: unknown;
  client?: { connId?: string };
  respond(
    ok: boolean,
    payload?: unknown,
    error?: { code: string; message: string },
  ): void;
}
interface PluginApi {
  registerGatewayMethod(
    name: string,
    handler: (request: GatewayRequest) => void,
    options: { scope: "operator.admin" },
  ): void;
  registerTool(
    factory: {
      contextVersion: 2;
      create(context: NativeToolContext): NativeTool[];
    },
    options?: { optional?: boolean; name?: string },
  ): void;
}
interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonObject;
}
interface Binding {
  runId: string;
  owner: string;
  endpoint: string;
  token: string;
  tools: ToolDescriptor[];
  expiresAt: number;
}

/** Optional local Gateway plugin. Native tools/loop/policy remain owned by OpenClaw. */
export default {
  id: "agent-host",
  name: "Agent Host product tools",
  register(api: PluginApi) {
    const bindings = new Map<string, Binding>();
    const current = (key: string) => {
      const binding = bindings.get(key);
      if (binding && binding.expiresAt < Date.now()) {
        bindings.delete(key);
        return undefined;
      }
      return binding;
    };
    const register = (
      name: string,
      run: (params: JsonObject, owner: string) => unknown,
    ) =>
      api.registerGatewayMethod(
        name,
        (request) => {
          try {
            const owner = request.client?.connId;
            if (!owner)
              throw new Error("authenticated_gateway_connection_required");
            request.respond(true, run(object(request.params), owner));
          } catch (error) {
            request.respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        },
        { scope: "operator.admin" },
      );
    register("agent-host.describe", () => ({
      protocol: 1,
      productTools: true,
      transport: "loopback",
      leaseMs: 90_000,
    }));
    register("agent-host.bind", (params, owner) => {
      const sessionKey = string(params.sessionKey),
        runId = string(params.runId);
      const previous = current(sessionKey);
      if (previous && (previous.runId !== runId || previous.owner !== owner))
        throw new Error("product_tool_session_busy");
      const endpoint = new URL(string(params.endpoint));
      if (
        endpoint.protocol !== "http:" ||
        endpoint.hostname !== "127.0.0.1" ||
        endpoint.username ||
        endpoint.password ||
        endpoint.pathname !== "/" ||
        endpoint.search ||
        endpoint.hash
      )
        throw new Error("product_tool_endpoint_must_be_loopback");
      const token = string(params.token);
      if (!/^acphost_[\w-]{40,64}$/.test(token))
        throw new Error("product_tool_token_invalid");
      if (!Array.isArray(params.tools) || params.tools.length > 128)
        throw new Error("product_tools_invalid");
      const tools = params.tools.map((value) => {
        const tool = object(value);
        if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(string(tool.name)))
          throw new Error("product_tool_name_invalid");
        if (
          typeof tool.description !== "string" ||
          object(tool.inputSchema).type !== "object"
        )
          throw new Error("product_tool_schema_invalid");
        return {
          name: string(tool.name),
          description: tool.description,
          inputSchema: object(tool.inputSchema),
        };
      });
      if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
        throw new Error("duplicate_product_tool");
      bindings.set(sessionKey, {
        runId,
        owner,
        endpoint: endpoint.origin,
        token,
        tools,
        expiresAt: Date.now() + 90_000,
      });
      return { ok: true };
    });
    for (const action of ["renew", "unbind"] as const)
      register(`agent-host.${action}`, (params, owner) => {
        const key = string(params.sessionKey),
          binding = current(key);
        if (!binding) return { ok: true };
        if (binding.owner !== owner || binding.runId !== params.runId)
          throw new Error("product_tool_lease_mismatch");
        if (action === "renew") binding.expiresAt = Date.now() + 90_000;
        else bindings.delete(key);
        return { ok: true };
      });
    api.registerTool(
      {
        contextVersion: 2,
        create(context) {
          const key = context.sessionKey;
          const binding = key ? current(key) : undefined;
          if (!key || !binding) return [];
          return [
            {
              name: "agent_host_call",
              label: "Product action",
              description:
                "Call a product tool. Available tools: " +
                binding.tools
                  .map(
                    (tool) =>
                      `${String(tool.name)}: ${String(tool.description)}`,
                  )
                  .join("\n"),
              parameters: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                    enum: binding.tools.map((tool) => tool.name),
                  },
                  input: { type: "object" },
                },
                required: ["name", "input"],
                additionalProperties: false,
                oneOf: binding.tools.map((tool) => ({
                  properties: {
                    name: { const: tool.name },
                    input: tool.inputSchema,
                  },
                })),
              },
              async execute(callId, input, signal) {
                context.assertInvocationCurrent();
                if (current(key) !== binding)
                  throw new Error("product_tool_binding_expired");
                const args = object(input),
                  name = string(args.name);
                if (!binding.tools.some((tool) => tool.name === name))
                  throw new Error("product_tool_not_available");
                const response = await fetch(`${binding.endpoint}/call`, {
                  method: "POST",
                  headers: {
                    authorization: `Bearer ${binding.token}`,
                    "content-type": "application/json",
                  },
                  body: JSON.stringify({ name, arguments: args.input, callId }),
                  signal,
                });
                if (!response.ok)
                  throw new Error(
                    `product_tool_host_unavailable:${response.status}`,
                  );
                const result = object(await response.json());
                if (!Array.isArray(result.content))
                  throw new Error("product_tool_result_invalid");
                return {
                  content: result.content,
                  details: { isError: result.isError === true },
                };
              },
            },
          ];
        },
      },
      { optional: false, name: "agent_host_call" },
    );
  },
};
function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new Error("product_tool_binding_invalid");
  return value;
}
