import { z } from "zod/v4";
import {
  createSdkMcpServer,
  tool as sdkTool,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import type { JsonObject, JsonValue } from "../types.js";
type ZodSchema = z.ZodType<unknown>;
type ZodShape = Record<string, ZodSchema>;
function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function readString(value: JsonObject, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}
/** Keeps SDK/Zod schema implementation types inside the adapter. */
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
}) {
  return createSdkMcpServer({
    name: input.name,
    version: input.version,
    tools: input.tools.map((tool) =>
      sdkTool(
        tool.name,
        tool.description,
        jsonSchemaToZodShape(tool.inputSchema),
        (args) => input.call(tool.name, args),
        { annotations: tool.annotations },
      ),
    ),
  });
}
export function jsonSchemaToZodShape(schema: JsonObject): ZodShape {
  const rootType = schema.type;
  if (rootType !== "object" && !isJsonObject(schema.properties)) {
    return { value: jsonSchemaToZod(schema) };
  }

  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  );
  const properties = isJsonObject(schema.properties) ? schema.properties : {};
  const shape: ZodShape = {};
  for (const [key, value] of Object.entries(properties)) {
    const childSchema = isJsonObject(value) ? value : {};
    const child = jsonSchemaToZod(childSchema);
    shape[key] = required.has(key) ? child : child.optional();
  }
  return shape;
}

function jsonSchemaToZod(schema: JsonObject): ZodSchema {
  let parsed: ZodSchema;
  const enumValues = Array.isArray(schema.enum)
    ? schema.enum.filter((item): item is string => typeof item === "string")
    : [];
  if (enumValues.length > 0) {
    parsed = z.enum(enumValues as [string, ...string[]]);
  } else if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    parsed = unionSchema([
      ...((schema.anyOf as JsonValue[] | undefined) ?? []),
      ...((schema.oneOf as JsonValue[] | undefined) ?? []),
    ]);
  } else {
    const type = schema.type;
    if (type === "string") {
      parsed = z.string();
    } else if (type === "number") {
      parsed = z.number();
    } else if (type === "integer") {
      parsed = z.number().int();
    } else if (type === "boolean") {
      parsed = z.boolean();
    } else if (type === "array") {
      parsed = z.array(
        isJsonObject(schema.items)
          ? jsonSchemaToZod(schema.items)
          : z.unknown(),
      );
    } else if (type === "object" || isJsonObject(schema.properties)) {
      parsed = z
        .object(jsonSchemaToZodShape(schema))
        .catchall(
          schema.additionalProperties === false ? z.never() : z.unknown(),
        );
    } else if (type === "null") {
      parsed = z.null();
    } else {
      parsed = z.unknown();
    }
  }

  const description = readString(schema, "description");
  return description ? parsed.describe(description) : parsed;
}

function unionSchema(values: JsonValue[]): ZodSchema {
  const schemas = values.filter(isJsonObject).map(jsonSchemaToZod);
  if (schemas.length === 0) {
    return z.unknown();
  }
  if (schemas.length === 1) {
    return schemas[0]!;
  }
  return z.union(schemas as [ZodSchema, ZodSchema, ...ZodSchema[]]);
}
