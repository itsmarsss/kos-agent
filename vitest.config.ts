import { defineConfig } from "vitest/config";

/**
 * Root test config. `.claude/` is excluded because agent worktrees live there:
 * they hold full copies of the tree at other commits, and collecting their
 * specs produces failures that look like this checkout's but are not.
 */
export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.claude/**",
      "**/.git/**",
    ],
  },
});
