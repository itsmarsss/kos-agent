/**
 * The built-in modules that are features rather than primitives.
 *
 * The kernel ships them, but a kernel that is primitives does not insist
 * on them: each can be switched off in Settings beside the workspace's
 * own modules. Off means its tools are taken back at once, no restart;
 * on means they are registered again. Everything else the kernel loads
 * (files, sql, shell, http, search, memory, chats, schedules, daemons,
 * skills, MCP) is the harness itself and has no switch.
 */

export interface BuiltinFeature {
  name: string;
  description: string;
}

export const BUILTIN_FEATURES: BuiltinFeature[] = [
  { name: "tasks", description: "Task lists, one per project instance" },
  { name: "sites", description: "Pages and sites KOS writes and serves" },
  { name: "export", description: "Query results as CSV or markdown" },
  { name: "builds", description: "Larger builds handed to a Claude Code sub-agent" },
];

export function isBuiltinFeature(name: string): boolean {
  return BUILTIN_FEATURES.some((f) => f.name === name);
}
