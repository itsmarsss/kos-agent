import { guestOrigin } from "../kernel/caller.js";
import { beyondAutoByName } from "../risk/beyondauto.js";
import type { ToolRisk } from "../risk/tiers.js";

/**
 * The risk of each Google tool, judged from the tool and its arguments as
 * every risk rule is, never from what a tool returned.
 *
 * Every call does one of five things. A read looks and changes nothing and
 * runs. Every other call asks, is beyond Auto, and no learned yes (a burst,
 * a job's consent) covers it: a write to the owner's account is judged on
 * the card each time, since a folder, a calendar or a doc may be someone
 * else's too. A change alters the owner's own things (a draft, a label, an
 * edit). Reaching a person is anything another person may see or anything
 * fetched from outside: a share or sharing setting, a guest, an invitation
 * or answer, a comment, a folder or calendar other than the owner's own
 * root, a URL the server would fetch. A delete is a delete. Sending mail
 * asks every time, whatever rule the owner kept.
 *
 * Arguments are read as loosely as the server reads them: a label list
 * given as a JSON string, a `trashed` of "true" or 1, a URL anywhere.
 *
 * A tool this table does not know asks, beyond Auto, so a server update that
 * adds one never runs it unasked.
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
  return Array.isArray(value) ? value.length > 0 : typeof value === "string" && value.trim() !== "" && value.trim() !== "[]";
}

/** Labels added that put mail in the bin, however the list is spelled: an array, a JSON string, one id. */
function trashes(input: Record<string, unknown>): boolean {
  const added = input["add_label_ids"];
  return added !== undefined && added !== null && /trash/i.test(JSON.stringify(added));
}

/** A `trashed` that is anything but absent or false: the server reads "true" and 1 as true. */
function binned(input: Record<string, unknown>): boolean {
  const t = input["trashed"];
  return t !== undefined && t !== null && t !== false;
}

/** A URL anywhere in the arguments: the server fetches it, unjailed from KOS's point of view, or puts it where others see. */
const URLISH = /^\s*[a-z][a-z0-9+.-]*:\/\//i;
function urlIn(value: unknown, key = ""): boolean {
  if (typeof value === "string") return URLISH.test(value) || (/url|uri/i.test(key) && value.trim() !== "");
  if (Array.isArray(value)) return value.some((v) => urlIn(v, key));
  if (value && typeof value === "object") return Object.entries(value).some(([k, v]) => urlIn(v, k));
  return false;
}

/** Where a write lands, when it is not the owner's own root or primary calendar: a shared folder or calendar is someone else's too. */
const PLACES: Record<string, string> = { folder_id: "root", parent_folder_id: "root", calendar_id: "primary", destination_calendar_id: "primary" };
const ELSEWHERE = ["add_parents", "shortcut_target_id"];
/** Settings that decide who else may see, share or join. */
const SHARING = ["writers_can_share", "copy_requires_writer_permission", "link_sharing", "allow_file_discovery", "visibility", "guests_can_modify", "guests_can_invite_others", "guests_can_see_other_guests", "attendees", "share_with", "recipients"];

function elsewhere(input: Record<string, unknown>): boolean {
  for (const [key, own] of Object.entries(PLACES)) {
    const v = input[key];
    if (v !== undefined && v !== null && v !== "" && String(v).trim().toLowerCase() !== own) return true;
  }
  return ELSEWHERE.some((k) => listed(input[k])) || SHARING.some((k) => input[k] !== undefined && input[k] !== null && !(Array.isArray(input[k]) && (input[k] as unknown[]).length === 0));
}

/** A write's effect raised to reaching a person when it lands, links or fetches past the owner's own things. */
function reachCheck(judge: Judge): Judge {
  return (input) => {
    const e = judge(input);
    return e === "change" && (urlIn(input) || elsewhere(input)) ? "person" : e;
  };
}

/** Every write to an event may reach its guests, who are told of it whatever `send_updates` says once they are on it. */
const event: Judge = (input) => {
  const action = actionOf(input);
  if (action === "delete") return "delete";
  if (action === "create") return "change";
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
  update_drive_file: (input) => (binned(input) ? "delete" : "change"),
  manage_drive_access: byAction({ grant: "person", grant_batch: "person", update: "person", transfer_owner: "person", revoke: "delete" }),
  set_drive_file_permissions: always("person"),
  manage_doc_tab: byAction({ create: "change", rename: "change", populate_from_markdown: "change", delete: "delete" }),
  manage_document_comment: byAction({ create: "person", reply: "person", update: "person", resolve: "person", delete: "delete" }),
};

/** What a call of a known tool does; undefined for a tool this table does not know. */
export function googleEffect(tool: string, input: Record<string, unknown>): GoogleEffect | undefined {
  const judge = GOOGLE_TOOLS[tool];
  return judge ? reachCheck(judge)(input) : undefined;
}

/** Why an ask about each kind of call asks, in the owner's words. */
const WHY: Record<Exclude<GoogleEffect, "read">, string> = {
  change: "changes your Google account",
  person: "may reach someone besides you, or fetch from outside, through your Google account",
  delete: "deletes from your Google account",
  send: "sends mail from your Google account",
};

/** Why a guest's work never touches the owner's Google account. */
export const GUEST_REFUSAL = "Google is the owner's account; a guest's words started this work, and it never reads or changes it.";

/**
 * The full risk of one of the server's tools. A read is safe. Anything else
 * asks with what it does said on the card, is beyond Auto, and is never
 * learned; a send asks every time.
 */
export function googleToolRisk(tool: string): ToolRisk {
  const refuse = (): string | false => (guestOrigin() ? GUEST_REFUSAL : false);
  if (!GOOGLE_TOOLS[tool]) {
    const why = `${tool} is a Google tool KOS does not know yet`;
    return { floor: "risky", why, refuse, beyondAuto: () => beyondAutoByName(tool) || why, neverLearned: () => true };
  }
  if (READS.has(tool)) return { floor: "safe", refuse };
  const effect = (input: Record<string, unknown>): GoogleEffect => googleEffect(tool, input)!;
  const words = (input: Record<string, unknown>): string | false => {
    const e = effect(input);
    return e === "read" ? false : WHY[e];
  };
  return {
    floor: "risky",
    relax: (input) => effect(input) === "read",
    why: (input) => words(input) || undefined,
    refuse,
    beyondAuto: words,
    neverLearned: (input) => words(input) !== false,
    ...(tool === SEND ? { asksAlways: true } : {}),
  };
}
