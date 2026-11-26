import { guestOrigin } from "../kernel/caller.js";
import { beyondAutoByName } from "../risk/beyondauto.js";
import type { ToolRisk } from "../risk/tiers.js";

/**
 * The risk of each Google tool, judged from the tool and its arguments as
 * every risk rule is, never from what a tool returned.
 *
 * Every call does one of five things. A read looks and changes nothing. A
 * change alters the owner's own account (a draft, a label, an edit) and asks.
 * Reaching a person (sharing a file, inviting a guest, answering an
 * invitation, a comment others on the doc see) asks, and no learned yes
 * covers it, as a message to anyone but the owner. A delete asks and is never
 * learned. Sending mail asks every time: no remembered decision, burst, job
 * consent or Auto covers it.
 *
 * A tool this table does not know asks, so a server update that adds one
 * never runs it unasked.
 */

export type GoogleEffect = "read" | "change" | "person" | "delete" | "send";

type Judge = (input: Record<string, unknown>) => GoogleEffect;

const always =
  (effect: GoogleEffect): Judge =>
  () =>
    effect;

/** The `action` argument, as the server reads it: trimmed, lower case. */
function actionOf(input: Record<string, unknown>): string {
  return typeof input["action"] === "string" ? input["action"].trim().toLowerCase() : "";
}

/** A tool that takes an `action`, judged by it; an action not listed is the most a person could be reached by. */
function byAction(actions: Record<string, GoogleEffect>): Judge {
  return (input) => actions[actionOf(input)] ?? "person";
}

function listed(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : typeof value === "string" && value.trim() !== "";
}

/** Labels added that put mail in the bin. */
function trashes(input: Record<string, unknown>): boolean {
  const added = input["add_label_ids"];
  return Array.isArray(added) && added.some((id) => typeof id === "string" && id.toUpperCase() === "TRASH");
}

/**
 * An event's guests hear of what is done to it (Google emails them unless
 * told not to), so a write with guests, or one that does not say "none", may
 * reach people; a new event with nobody on it reaches nobody.
 */
const event: Judge = (input) => {
  const action = actionOf(input);
  const quiet = input["send_updates"] === "none" && !listed(input["attendees"]);
  if (action === "delete") return "delete";
  if (action === "rsvp") return "person";
  if (action === "create") return listed(input["attendees"]) ? "person" : "change";
  if (action === "update" || action === "move") return quiet ? "change" : "person";
  return "person";
};

/** Out of office and focus time decline other people's invitations unless told not to. */
const declining: Judge = (input) => {
  const action = actionOf(input);
  if (action === "list") return "read";
  if (action === "delete") return "delete";
  if (action === "create" || action === "update") return input["auto_decline_mode"] === "declineNone" ? "change" : "person";
  return "person";
};

const labels: Judge = (input) => (trashes(input) ? "delete" : "change");

const READS = new Set([
  // Gmail
  "search_gmail_messages",
  "get_gmail_message_content",
  "get_gmail_messages_content_batch",
  "get_gmail_attachment_content",
  "get_gmail_thread_content",
  "get_gmail_threads_content_batch",
  "list_gmail_labels",
  // Calendar
  "list_calendars",
  "get_events",
  "query_freebusy",
  // Drive
  "search_drive_files",
  "get_drive_file_content",
  "get_drive_file_download_url",
  "list_drive_items",
  "get_drive_file_permissions",
  "check_drive_file_public_access",
  "get_drive_shareable_link",
  // Docs
  "search_docs",
  "get_doc_content",
  "list_docs_in_folder",
  "inspect_doc_structure",
  "debug_table_structure",
  "get_doc_as_markdown",
  "list_document_comments",
]);

/** The one tool that sends mail. */
const SEND = "send_gmail_message";

const CHANGES = [
  "draft_gmail_message",
  "create_drive_folder",
  "create_drive_file",
  "import_to_google_doc",
  "import_to_google_slides",
  "import_to_google_sheets",
  "copy_drive_file",
  "create_doc",
  "modify_doc_text",
  "find_and_replace_doc",
  "insert_doc_elements",
  "insert_doc_image",
  "update_doc_headers_footers",
  "batch_update_doc",
  "create_table_with_data",
  "export_doc_to_pdf",
  "update_paragraph_style",
];

/** Each known tool's judge, by its name on the server. */
export const GOOGLE_TOOLS: Readonly<Record<string, Judge>> = {
  ...Object.fromEntries([...READS].map((t) => [t, always("read")])),
  ...Object.fromEntries(CHANGES.map((t) => [t, always("change")])),
  [SEND]: always("send"),
  manage_gmail_label: byAction({ create: "change", update: "change", delete: "delete" }),
  modify_gmail_message_labels: labels,
  batch_modify_gmail_message_labels: labels,
  manage_event: event,
  manage_out_of_office: declining,
  manage_focus_time: declining,
  manage_calendar: byAction({ create: "change", list_sharing: "read", share: "person", update_sharing: "person", unshare: "delete" }),
  update_drive_file: (input) => (input["trashed"] === true ? "delete" : "change"),
  manage_drive_access: byAction({ grant: "person", grant_batch: "person", update: "person", transfer_owner: "person", revoke: "delete" }),
  set_drive_file_permissions: always("person"),
  manage_doc_tab: byAction({ create: "change", rename: "change", populate_from_markdown: "change", delete: "delete" }),
  manage_document_comment: byAction({ create: "person", reply: "person", update: "change", resolve: "change", delete: "delete" }),
};

/** What a call of a known tool does; undefined for a tool this table does not know. */
export function googleEffect(tool: string, input: Record<string, unknown>): GoogleEffect | undefined {
  return GOOGLE_TOOLS[tool]?.(input);
}

/** Why an ask about each kind of call asks, in the owner's words. */
const WHY: Record<Exclude<GoogleEffect, "read">, string> = {
  change: "changes your Google account",
  person: "reaches someone besides you through your Google account",
  delete: "deletes from your Google account",
  send: "sends mail from your Google account",
};

/** Why a guest's work never touches the owner's Google account. */
export const GUEST_REFUSAL = "Google is the owner's account; a guest's words started this work, and it never reads or changes it.";

/**
 * The full risk of one of the server's tools. A read is safe; anything else
 * asks, with what it does said on the card. A delete and anything reaching a
 * person are beyond Auto and never learned; a send asks every time.
 */
export function googleToolRisk(tool: string): ToolRisk {
  const judge = GOOGLE_TOOLS[tool];
  const refuse = (): string | false => (guestOrigin() ? GUEST_REFUSAL : false);
  if (!judge) {
    return { floor: "risky", why: `${tool} is a Google tool KOS does not know yet`, refuse, beyondAuto: () => beyondAutoByName(tool) };
  }
  if (READS.has(tool)) return { floor: "safe", refuse };
  const effect = (input: Record<string, unknown>): GoogleEffect => judge(input);
  const reaches = (input: Record<string, unknown>): string | false => {
    const e = effect(input);
    return e === "person" || e === "delete" || e === "send" ? WHY[e] : false;
  };
  return {
    floor: "risky",
    relax: (input) => effect(input) === "read",
    why: (input) => {
      const e = effect(input);
      return e === "read" ? undefined : WHY[e];
    },
    refuse,
    beyondAuto: reaches,
    neverLearned: (input) => reaches(input) !== false,
    ...(tool === SEND ? { asksAlways: true } : {}),
  };
}
