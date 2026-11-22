import { Switch } from "@kos/kit";
import { toolWords } from "@kos/shared";
import { useState, type ReactElement } from "react";

import type { ToolInfo } from "./api.js";

/**
 * What a chat or a blob may reach, as a few plain groups with a switch each
 * (design.md: a switch, never a checkbox): "Files and folders", "The web",
 * "Memory". The scope is stored in tool families (files, browser, memory),
 * so a group's switch turns all of its families on or off; the families
 * themselves, with what each does, wait under Advanced for the curious.
 * Null is the full toolkit; an empty list is no tools at all, a real choice.
 */

/** Group tools by their prefix; the scope is expressed in those terms. */
export function familiesOf(tools: ToolInfo[]): string[] {
  const seen = new Set<string>();
  for (const t of tools) seen.add(familyOf(t.name));
  return [...seen].sort();
}

function familyOf(tool: string): string {
  return tool.split(".")[0] ?? tool;
}

/** The plain groups, in the order the owner thinks of them, and the families each holds. */
export const TOOL_GROUPS: readonly { name: string; line: string; families: readonly string[] }[] = [
  { name: "Files and folders", line: "Read, write and search the workspace's files", families: ["files", "search", "export", "tex"] },
  { name: "The web", line: "Fetch pages and work in KOS's own browser", families: ["http", "browser", "sites"] },
  { name: "Memory", line: "Remember and recall what it learns", families: ["memory", "context"] },
  { name: "Schedules", line: "Set up and run things on a timer", families: ["cron"] },
  { name: "Projects and tables", line: "Projects, their tables, tasks and artifacts", families: ["systems", "sql", "tasks", "modules", "artifacts", "pages"] },
  { name: "Messages and chats", line: "Tell you things, and hand work to other chats", families: ["notify", "functions", "chats", "blobs", "discord"] },
  { name: "Run code", line: "Commands, Python, skills and background programs", families: ["shell", "python", "skills", "daemons", "builds", "danger"] },
  { name: "Secrets", line: "Use saved logins, cards and keys without seeing them", families: ["secrets", "vault", "shop"] },
  { name: "Your computer", line: "Work on a Mac or in a Chrome you paired", families: ["computer", "chrome"] },
];

const OTHER = { name: "Everything else", line: "Tools added by servers and modules" };

/** The groups the toolkit has, each with the families of it that are present; what no group names is Everything else. */
export function groupsOf(families: readonly string[]): { name: string; line: string; families: string[] }[] {
  const placed = new Set<string>();
  const groups = TOOL_GROUPS.map((g) => {
    const mine = g.families.filter((f) => families.includes(f));
    mine.forEach((f) => placed.add(f));
    return { name: g.name, line: g.line, families: mine };
  }).filter((g) => g.families.length > 0);
  const rest = families.filter((f) => !placed.has(f));
  return rest.length ? [...groups, { ...OTHER, families: rest }] : groups;
}

export interface ToolPickerProps {
  tools: ToolInfo[];
  allow: string[] | null;
  onChange: (allow: string[] | null) => void;
}

export function ToolPicker({ tools, allow, onChange }: ToolPickerProps): ReactElement {
  const families = familiesOf(tools);
  const groups = groupsOf(families);
  const [advanced, setAdvanced] = useState(false);
  const unrestricted = allow === null;
  const isOn = (f: string): boolean => allow === null || allow.includes(f);
  const off = groups.filter((g) => !g.families.some(isOn)).length;
  /** Sets some families on or off; the first change to the full toolkit starts from all of it. */
  const set = (some: readonly string[], on: boolean): void => {
    const base = allow ?? families;
    onChange(on ? [...new Set([...base, ...some])] : base.filter((f) => !some.includes(f)));
  };
  return (
    <div className="toolpick-wrap">
      <div className="toolpick">
        {families.length === 0 && <p className="hint">Loading the toolkit…</p>}
        {groups.map((g) => {
          const on = g.families.some(isOn);
          return (
            <div key={g.name} className={`toolpick-row ${on ? "is-on" : ""}`}>
              <span className="toolpick-main">
                <span className="toolpick-name toolpick-name--plain">{g.name}</span>
                <span className="toolpick-tools">{g.line}</span>
              </span>
              <Switch label={g.name} on={on} onChange={(next) => set(g.families, next)} />
            </div>
          );
        })}
      </div>
      {families.length > 0 && (
        <button type="button" className="link sched-toggle" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}>
          {advanced ? "Hide each tool family" : "Advanced: each tool family"}
        </button>
      )}
      {advanced && (
        <div className="toolpick">
          {families.map((f) => {
            const owned = tools.filter((t) => familyOf(t.name) === f);
            return (
              <div key={f} className={`toolpick-row ${isOn(f) ? "is-on" : ""}`}>
                <span className="toolpick-main">
                  <span className="toolpick-name">{f}</span>
                  <span className="toolpick-tools">{[...new Set(owned.map((t) => toolWords(t.name)))].join(", ")}</span>
                </span>
                <span className="toolpick-count">{owned.length}</span>
                <Switch label={f} on={isOn(f)} onChange={(next) => set([f], next)} />
              </div>
            );
          })}
        </div>
      )}
      <div className="toolpick-foot">
        <span className="hint">
          {unrestricted
            ? "Everything KOS can do."
            : allow.length === 0
              ? "No tools at all: it can talk, and nothing else."
              : `Only what is switched on; ${off} group${off === 1 ? "" : "s"} off.`}
        </span>
        {!unrestricted && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => onChange(null)}>
            Everything
          </button>
        )}
      </div>
    </div>
  );
}
