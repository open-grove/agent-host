import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
  type CallToolResult,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";
import type { JsonObject } from "../types.js";

/** The SDK accepts an MCP server instance. Its documented low-level handlers preserve the product's complete JSON Schema without a lossy Zod round trip. */
export function createClaudeMcpServer(input: {
  name: string;
  version?: string;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: JsonObject;
    annotations?: ToolAnnotations;
  }>;
  call(name: string, input: unknown): Promise<CallToolResult>;
}): McpSdkServerConfigWithInstance {
  const instance = new McpServer(
    { name: input.name, version: input.version ?? "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const definitions = input.tools.map((tool) => ToolSchema.parse(tool));
  if (new Set(definitions.map((tool) => tool.name)).size !== definitions.length)
    throw new Error("duplicate_tool_name");
  const validator = new AjvJsonSchemaValidator();
  const validators = new Map(
    definitions.map((tool) => [
      tool.name,
      validator.getValidator<JsonObject>(tool.inputSchema as JsonSchemaType),
    ]),
  );
  instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: definitions,
  }));
  instance.server.setRequestHandler(
    CallToolRequestSchema,
    async ({ params }) => {
      const validate = validators.get(params.name);
      if (!validate)
        return {
          isError: true,
          content: [
            { type: "text", text: `Unknown product tool: ${params.name}` },
          ],
        };
      const result = validate(params.arguments ?? {});
      if (!result.valid)
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Invalid tool input: ${result.errorMessage}`,
            },
          ],
        };
      return input.call(params.name, result.data);
    },
  );
  return { type: "sdk", name: input.name, instance };
}
