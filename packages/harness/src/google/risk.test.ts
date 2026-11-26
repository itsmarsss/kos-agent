import { describe, expect, it } from "vitest";

import { guested } from "../kernel/caller.js";
import { learnable } from "../risk/learned.js";
import { classifyRisk } from "../risk/tiers.js";
import { GOOGLE_TOOLS, GUEST_REFUSAL, googleEffect, googleToolRisk } from "./risk.js";

/** The tools workspace-mcp 2.7.0 lists for calendar, gmail, drive and docs in send mode, the widest KOS runs. */
const LISTED = [
  "search_gmail_messages", "get_gmail_message_content", "get_gmail_messages_content_batch", "get_gmail_attachment_content", "send_gmail_message",
  "draft_gmail_message", "get_gmail_thread_content", "get_gmail_threads_content_batch", "list_gmail_labels", "manage_gmail_label",
  "modify_gmail_message_labels", "batch_modify_gmail_message_labels", "list_calendars", "get_events", "manage_event", "manage_out_of_office",
  "manage_focus_time", "query_freebusy", "manage_calendar", "search_drive_files", "get_drive_file_content", "get_drive_file_download_url",
  "list_drive_items", "create_drive_folder", "create_drive_file", "import_to_google_doc", "import_to_google_slides", "import_to_google_sheets",
  "get_drive_file_permissions", "check_drive_file_public_access", "update_drive_file", "get_drive_shareable_link", "manage_drive_access",
  "copy_drive_file", "set_drive_file_permissions", "search_docs", "get_doc_content", "list_docs_in_folder", "create_doc", "modify_doc_text",
  "find_and_replace_doc", "insert_doc_elements", "insert_doc_image", "update_doc_headers_footers", "batch_update_doc", "inspect_doc_structure",
  "create_table_with_data", "debug_table_structure", "export_doc_to_pdf", "update_paragraph_style", "get_doc_as_markdown", "manage_doc_tab",
  "list_document_comments", "manage_document_comment",
];

function judged(tool: string, input: Record<string, unknown> = {}) {
  return classifyRisk(googleToolRisk(tool), input);
}

function learns(tool: string, input: Record<string, unknown> = {}): boolean {
  return learnable({ tool: `mcp.google.${tool}`, input, assessment: judged(tool, input), guest: false, secret: false, strict: false, yours: false });
}

describe("Google tool risk", () => {
  it("knows every tool the pinned server lists, and nothing it does not", () => {
    expect(LISTED.filter((t) => !(t in GOOGLE_TOOLS))).toEqual([]);
    expect(Object.keys(GOOGLE_TOOLS).filter((t) => !LISTED.includes(t))).toEqual([]);
  });

  it("runs reads without asking", () => {
    for (const tool of ["search_gmail_messages", "get_gmail_message_content", "get_events", "list_calendars", "search_drive_files", "get_drive_file_content", "get_doc_content", "get_doc_as_markdown", "list_document_comments"]) {
      expect(judged(tool).tier, tool).toBe("safe");
    }
    expect(judged("manage_calendar", { action: "list_sharing" }).tier).toBe("safe");
    expect(judged("manage_out_of_office", { action: "list" }).tier).toBe("safe");
  });

  it("asks for a change, and lets a learned yes cover it", () => {
    for (const [tool, input] of [
      ["draft_gmail_message", { to: "a@b.c" }],
      ["manage_gmail_label", { action: "create", name: "x" }],
      ["modify_gmail_message_labels", { add_label_ids: ["STARRED"] }],
      ["manage_event", { action: "create", summary: "Dentist" }],
      ["manage_event", { action: "update", event_id: "e", send_updates: "none" }],
      ["create_doc", { title: "Notes" }],
      ["update_drive_file", { file_id: "f", name: "n" }],
    ] as const) {
      const a = judged(tool, input);
      expect(a.tier, tool).toBe("risky");
      expect(a.beyondAuto, tool).toBeUndefined();
      expect(learns(tool, input), tool).toBe(true);
    }
  });

  it("asks every time to send mail, and no saved yes, burst or job rule covers it", () => {
    const a = judged("send_gmail_message", { to: "a@b.c", subject: "hi", body: "x" });
    expect(a.tier).toBe("risky");
    expect(a.asksAlways).toBe(true);
    expect(a.neverLearned).toBe(true);
    expect(a.beyondAuto).toBeDefined();
    expect(learns("send_gmail_message", { to: "a@b.c" })).toBe(false);
  });

  it("counts a delete as a delete: asked, never learned, beyond Auto", () => {
    for (const [tool, input] of [
      ["manage_event", { action: "delete", event_id: "e" }],
      ["manage_gmail_label", { action: "delete", label_id: "l" }],
      ["modify_gmail_message_labels", { message_id: "m", add_label_ids: ["TRASH"] }],
      ["batch_modify_gmail_message_labels", { message_ids: ["m"], add_label_ids: ["trash"] }],
      ["update_drive_file", { file_id: "f", trashed: true }],
      ["manage_doc_tab", { action: "delete", tab_id: "t" }],
      ["manage_document_comment", { action: "delete", comment_id: "c" }],
      ["manage_drive_access", { action: "revoke", permission_id: "p" }],
    ] as const) {
      expect(googleEffect(tool, input), tool).toBe("delete");
      const a = judged(tool, input);
      expect(a.neverLearned, tool).toBe(true);
      expect(a.beyondAuto, tool).toBeDefined();
      expect(learns(tool, input), tool).toBe(false);
    }
  });

  it("counts sharing, inviting and answering as reaching a person", () => {
    for (const [tool, input] of [
      ["manage_drive_access", { action: "grant", file_id: "f", share_with: "x@y.z" }],
      ["manage_drive_access", { action: "transfer_owner", file_id: "f" }],
      ["set_drive_file_permissions", { file_id: "f", link_sharing: "anyone" }],
      ["manage_calendar", { action: "share", scope_value: "x@y.z" }],
      ["manage_event", { action: "create", attendees: ["x@y.z"] }],
      ["manage_event", { action: "update", event_id: "e" }],
      ["manage_event", { action: "rsvp", event_id: "e", response: "accepted" }],
      ["manage_document_comment", { action: "create", comment_content: "hi" }],
      ["manage_out_of_office", { action: "create" }],
    ] as const) {
      expect(googleEffect(tool, input), tool).toBe("person");
      expect(judged(tool, input).neverLearned, tool).toBe(true);
      expect(learns(tool, input), tool).toBe(false);
    }
  });

  it("asks for an action it does not know as if it reached a person", () => {
    expect(googleEffect("manage_event", { action: "explode" })).toBe("person");
  });

  it("asks for a tool it does not know", () => {
    const a = judged("brand_new_tool");
    expect(a.tier).toBe("risky");
    expect(a.reason).toContain("does not know");
    expect(judged("delete_everything").beyondAuto).toBeDefined();
  });

  it("refuses a guest's work outright, reads included", async () => {
    for (const tool of ["get_events", "send_gmail_message", "brand_new_tool"]) {
      const refuse = googleToolRisk(tool).refuse!;
      expect(await guested.run(undefined, () => refuse({}))).toBe(false);
      expect(await guested.run({ project: "club", chat: "c1" }, () => refuse({}))).toBe(GUEST_REFUSAL);
    }
  });

  it("judges by the arguments alone: what a mail said never changes a tier", () => {
    const risk = googleToolRisk("get_gmail_message_content");
    expect(risk.floor).toBe("safe");
    expect(risk.relax).toBeUndefined();
    expect(risk.escalate).toBeUndefined();
  });
});
