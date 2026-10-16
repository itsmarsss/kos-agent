import { describe, expect, it } from "vitest";

import { isReadOnlyCommand } from "./readonly.js";

/**
 * The line between looking and doing, drawn as an allow-list: a command the
 * rule can prove only reads runs without asking, and everything else asks.
 */
describe("read-only command lines", () => {
  const reads = [
    "ls",
    "ls -la projects/",
    "cat notes/today.md",
    "head -n 20 'a file.txt'",
    "grep -rn \"TODO\" src | head -50",
    "rg --files | wc -l",
    "git status",
    "git log --oneline -20",
    "git diff HEAD~1 -- src/",
    "git -C projects/x status",
    "git --no-pager branch -a",
    "git branch --show-current",
    "git tag -l 'v*'",
    "git remote -v",
    "git stash list",
    "git config --get user.name",
    "find . -name '*.md' -not -path './node_modules/*'",
    "pwd && ls && git status",
    "cat a.txt; cat b.txt",
    "ls nope 2>/dev/null || echo none",
    "cat big.log 2>&1 | tail -5",
    "sed -n '1,20p' README.md",
    "sed -e 's/foo/bar/g' README.md",
    "cd projects/x && git log -3",
    "/bin/ls -1",
    "du -sh projects",
    "pnpm ls --depth 0",
    "npm -v",
    "jq '.servers | keys' projects/x/config.json",
    "env | sort",
    "ls -la",
    "cat notes/today.md projects/x/plan.md",
  ];
  for (const c of reads) {
    it(`reads: ${c}`, () => expect(isReadOnlyCommand(c)).toBe(true));
  }

  const acts = [
    "",
    "rm -rf x",
    "ls && rm x",
    "cat a > b",
    "cat a >> b",
    "echo hi | tee out.txt",
    "ls $(echo x)",
    "ls `echo x`",
    "(ls)",
    "ls &",
    "sleep 100 & ls",
    "FOO=1 ls",
    "git push",
    "git checkout main",
    "git branch -D old",
    "git tag v1",
    "git remote add x y",
    "git stash pop",
    "git config user.name x",
    "git commit -m x",
    "git reset --hard",
    "git",
    "find . -name '*.tmp' -delete",
    "find . -exec rm {} \\;",
    "sed -i 's/a/b/' file",
    "sed 's/a/b/w out' file",
    "sed '1d' file",
    "awk '{print > \"out\"}' file",
    "xargs rm",
    "curl https://example.com",
    "python3 -c 'print(1)'",
    "node -e 'require(\"fs\").writeFileSync(\"x\",\"\")'",
    "sh -c 'rm x'",
    "pnpm install",
    "npm run build",
    "cat 'unterminated",
    "ls <(rm x)",
    "sudo ls",
    "chmod +x run.sh",
    "mv a b",
    "touch a",
    "kill 1",
    "cat < file > out",
    // KOS's own files and anything hidden: a read is what the approval is for.
    "cat .kos/browser-profile/Default/Cookies",
    "ls ./.kos",
    "sqlite3 kos.sqlite .dump",
    "cat mcp.json",
    "cat ./profile.json",
    "grep -r token .config/",
    "cat projects/x/.env",
    "head -c 100 locks/host",
  ];
  for (const c of acts) {
    it(`asks: ${c || "(empty)"}`, () => expect(isReadOnlyCommand(c)).toBe(false));
  }
});
