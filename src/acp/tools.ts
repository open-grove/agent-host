import type {
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import type { JsonObject } from "../types.js";
export interface HostToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonObject;
  annotations?: ToolAnnotations;
  liveness?: unknown;
}
/** Product policy and tool execution stay behind this boundary. */
export interface HostToolBridge {
  descriptors: HostToolDescriptor[];
  call(name: string, input: unknown, callId: string): Promise<CallToolResult>;
}
