import { describe, expect, it } from "vitest";

import { alwaysTip, alwaysWords, askPlace, askRisk, askView } from "./ask.js";
import { actionSteps, stepText, type StepLine } from "./format-action.js";

const text = (lines: StepLine[] | undefined): string[] | undefined => lines?.map(stepText);

/** The owner's case: zooming a Google Doc out in their own Chrome. */
const zoom = {
  intent: "Zoom the browser out so more of the document fits per screen",
  actions: [{ press: "Meta+Minus" }, { press: "Meta+Minus" }, { press: "Meta+Minus" }, { press: "Meta+Minus" }, { press: "Meta+Home" }],
};

describe("a step's lines", () => {
  it("say presses in a row as one, repeats by their count", () => {
    expect(text(actionSteps("browser.act", zoom))).toEqual(["Press ⌘− 4 times, then ⌘Home"]);
    expect(text(actionSteps("browser.act", zoom, "other"))).toEqual(["Press Ctrl+− 4 times, then Ctrl+Home"]);
    const three = { actions: [{ press: "Tab" }, { press: "Shift+Tab" }, { press: "Enter" }] };
    expect(text(actionSteps("browser.act", three))).toEqual(["Press Tab, ⇧Tab, then ⏎"]);
  });

  it("keep the keys as keys, for a surface that draws them as caps", () => {
    expect(actionSteps("browser.act", zoom)).toEqual([[{ text: "Press " }, { key: "⌘−" }, { text: " 4 times, then " }, { key: "⌘Home" }]]);
  });

  it("break a run of presses at anything else", () => {
    const steps = { actions: [{ click: "text=Search" }, { type: { target: "@e1", text: "flights" } }, { press: "Enter" }, { click: "text=Search" }, { click: "text=Search" }] };
    expect(text(actionSteps("browser.act", steps))).toEqual(["Click “Search”", "Type “flights”", "Press ⏎", "Click “Search” twice"]);
  });

  it("quote typed words and cut a long run of them", () => {
    const long = "Dear team, thank you all for the work on the launch this quarter. ".repeat(4);
    const [line] = text(actionSteps("computer.act", { action: "type", text: long }))!;
    expect(line).toBe("Type “Dear team, thank you all for the work on the la…”");
    expect(line!.length).toBeLessThan(60);
  });

  it("are a computer's keys on a Mac whatever the caller says", () => {
    expect(text(actionSteps("computer.act", { action: "key", text: "cmd+q" }, "other"))).toEqual(["Press ⌘Q"]);
  });

  it("are none for a tool that is not a run of actions", () => {
    expect(actionSteps("shell.run", { command: "ls" })).toBeUndefined();
  });
});

describe("an ask, as a card lays it out", () => {
  it("leads with the purpose, then where, the steps and why", () => {
    const view = askView({
      tool: "browser.act",
      args: JSON.stringify(zoom),
      reason: "clicks, types or fills on the page, in your Chrome",
      rule: { tool: "browser.*", scope: "your-chrome:docs.google.com", project: null },
      yours: true,
    });
    expect(view.title).toBe("Zoom the browser out so more of the document fits per screen");
    expect(view.place).toEqual({ words: "In your Chrome on docs.google.com", site: "docs.google.com" });
    expect(text(view.steps)).toEqual(["Press ⌘− 4 times, then ⌘Home"]);
    expect(view.risk).toBe("Clicks, types or fills on the page");
    expect(view.always).toBe("Always allow on docs.google.com");
    expect(view.alwaysTip).toMatch(/docs\.google\.com in your Chrome/);
    expect(view.alwaysTip).toMatch(/Settings, Permissions/);
  });

  it("titles a run with no purpose by where it acts, and one action by itself", () => {
    const run = askView({ tool: "computer.act", args: { actions: [{ action: "left_click" }, { action: "type", text: "hi" }] } });
    expect(run.title).toBe("Use your Mac");
    expect(text(run.steps)).toEqual(["Click", "Type “hi”"]);
    const one = askView({ tool: "computer.act", args: { action: "key", text: "cmd+q" } });
    expect(one.title).toBe("Press ⌘Q");
    expect(one.steps).toBeUndefined();
  });

  it("says no Always where nothing can be remembered", () => {
    const view = askView({ tool: "shell.run", args: { command: "rm -rf build" }, reason: "risky tool" });
    expect(view.always).toBeUndefined();
    expect(view.risk).toBeUndefined();
    expect(view.place).toEqual({ words: "In the workspace" });
  });
});

describe("where an ask acts", () => {
  it("names the browser and the site", () => {
    expect(askPlace({ tool: "browser.act", args: {}, rule: { tool: "browser.*", scope: "site:shop.example" } })).toEqual({ words: "In KOS's browser on shop.example", site: "shop.example" });
    expect(askPlace({ tool: "browser.visit", args: { url: "https://example.com/a" } })).toEqual({ words: "In KOS's browser on example.com", site: "example.com" });
    expect(askPlace({ tool: "browser.act", args: {}, yours: true })).toEqual({ words: "In your Chrome" });
  });

  it("names a folder, a host or a server", () => {
    expect(askPlace({ tool: "shell.run", args: { command: "make", cwd: "projects/site" } })).toEqual({ words: "In projects/site" });
    expect(askPlace({ tool: "files.rm", args: { path: "notes/old/a.md" } })).toEqual({ words: "In notes/old" });
    expect(askPlace({ tool: "http.fetch", args: { url: "https://api.example.com/x" } })).toEqual({ words: "On api.example.com", site: "api.example.com" });
    expect(askPlace({ tool: "mcp.gmail.send_email", args: {} })).toEqual({ words: "Through gmail" });
    expect(askPlace({ tool: "notify", args: {} })).toBeUndefined();
  });
});

describe("why an ask asks", () => {
  it("drops what the place already says", () => {
    expect(askRisk("clicks, types or fills on the page, in your Chrome")).toBe("Clicks, types or fills on the page");
    expect(askRisk("on shop.example")).toBeUndefined();
    expect(askRisk("risky tool")).toBeUndefined();
    expect(askRisk(null)).toBeUndefined();
    expect(askRisk("deletes files")).toBe("Deletes files");
  });
});

describe("a remembered yes", () => {
  it("says on its button what it covers", () => {
    expect(alwaysWords("your-chrome:shop.example")).toBe("Always allow on shop.example");
    expect(alwaysWords("dir:projects/budget")).toBe("Always allow in projects/budget");
    expect(alwaysWords("dir:")).toBe("Always allow in the workspace");
    expect(alwaysWords("cmd:git")).toBe("Always allow git");
    expect(alwaysWords("host:api.example.com")).toBe("Always allow for api.example.com");
    expect(alwaysWords(null)).toBe("Always allow");
    expect(alwaysWords("to:discord:channel:1")).toBe("Always allow here");
  });

  it("says on its tooltip exactly what stops asking and where to undo it", () => {
    expect(alwaysTip({ tool: "shell.run", scope: "cmd:git", project: "site" })).toBe(
      "Approves this, and from now on running git on its own stops asking in the project site. A chain or a pipe still asks. Undo it in Settings, Permissions.",
    );
    expect(alwaysTip({ tool: "files.rm", scope: "dir:notes" })).toBe("Approves this, and from now on files.rm in notes and the folders under it stops asking. Undo it in Settings, Permissions.");
    expect(alwaysTip({ tool: "cron.run", scope: null })).toBe("Approves this, and from now on cron.run stops asking, whatever it is given. Undo it in Settings, Permissions.");
  });
});
