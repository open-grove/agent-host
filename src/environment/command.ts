import { extname } from "node:path";

/** Node scripts need an interpreter; cross-spawn handles Windows command shims. */
export function resolveCommandInvocation(
  command: string,
  args: string[],
  _options?: { wrapWindowsScript: false },
) {
  if ([".js", ".mjs", ".cjs"].includes(extname(command).toLowerCase())) {
    return { command: process.execPath, args: [command, ...args] };
  }
  return { command, args };
}
