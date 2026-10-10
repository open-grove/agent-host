import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  fsyncSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HostError } from "./protocol.js";

function inside(root: string, path: string): string {
  const base = realpathSync(root);
  if (isAbsolute(path) || path.includes("\0"))
    throw new HostError(403, "workspace_path_outside_root");
  const target = resolve(base, path);
  const rel = relative(base, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new HostError(403, "workspace_path_outside_root");
  let current = base;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    // Disallow symlinks altogether, including dangling ones, in this optional file API.
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new HostError(403, "workspace_symlink_not_allowed");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return target;
}
const revision = (content: Buffer) =>
  createHash("sha256").update(content).digest("hex");
export function readWorkspaceFile(root: string, path: string) {
  const target = inside(root, path);
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new HostError(400, "workspace_not_a_file");
    if (stat.size > 1_000_000)
      throw new HostError(413, "workspace_file_too_large");
    const content = readFileSync(fd);
    return {
      path,
      content: content.toString("utf8"),
      revision: revision(content),
    };
  } finally {
    closeSync(fd);
  }
}
export function listWorkspaceFiles(root: string, path: string) {
  return readdirSync(inside(root, path), { withFileTypes: true })
    .slice(0, 1_000)
    .filter((entry) => !entry.isSymbolicLink())
    .map((entry) => ({
      path: join(path, entry.name).split(sep).join("/"),
      directory: entry.isDirectory(),
    }));
}
export function writeWorkspaceFile(
  root: string,
  path: string,
  content: string,
  expectedRevision?: string | null,
) {
  if (Buffer.byteLength(content) > 1_000_000)
    throw new HostError(413, "workspace_file_too_large");
  const target = inside(root, path);
  if (target === realpathSync(root))
    throw new HostError(400, "workspace_file_path_required");
  const previous = existsSync(target)
    ? readWorkspaceFile(root, path).revision
    : null;
  if (expectedRevision !== undefined && expectedRevision !== previous)
    throw new HostError(409, "workspace_revision_conflict");
  mkdirSync(dirname(target), { recursive: true });
  inside(root, path);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return { path, content, revision: revision(Buffer.from(content)) };
}
