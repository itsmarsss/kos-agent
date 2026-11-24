import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

/**
 * Credential hygiene on disk: the modes of what KOS keeps for the owner, and
 * where the env file sits. Read from paths and modes alone, so nothing here
 * asks macOS anything (no iCloud query, no Keychain) and nothing can prompt.
 */

/** The owner's ~/.kos: KOS's keys, locks and run state, denied to every jailed program. */
export const kosHome = (home = homedir()): string => join(home, ".kos");

/**
 * The folders of ~/.kos whose files are KOS's own state. The vault's folder
 * (secrets) keeps its modes itself, and Claude Code's (claude) its own.
 */
const OWN_DIRS = [".", "locks", "run"];

/** What a mode lets others do, as a word for the owner. */
const opened = (mode: number): string => `mode ${(mode & 0o777).toString(8)}`;

/**
 * ~/.kos and its locks and run folders made the owner's alone (0700), and
 * every file in them (0600): left 0755 and 0644, other local users could list
 * them and read the locks. Run at boot. Says which paths it changed.
 */
export function tightenKosHome(dir = kosHome()): string[] {
  const changed: string[] = [];
  const tighten = (path: string, mode: number): void => {
    if ((lstatSync(path).mode & 0o777) === mode) return;
    chmodSync(path, mode);
    changed.push(path);
  };
  for (const sub of OWN_DIRS) {
    const folder = join(dir, sub);
    if (!existsSync(folder) || !lstatSync(folder).isDirectory()) continue;
    tighten(folder, 0o700);
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (lstatSync(path).isFile()) tighten(path, 0o600);
    }
  }
  return changed;
}

/** A credential file or folder others can reach, and the line that fixes it. */
export interface ModeFinding {
  path: string;
  detail: string;
}

/**
 * Every credential file and folder of the inventory others may reach: the
 * env file, ~/.kos's own folders and files, the vault's folder, the device
 * and APNs key files an env var names, and the pick credentials (Google's
 * OAuth client and refresh tokens) in the credentials folder.
 */
export function credentialModes(options: { env: NodeJS.ProcessEnv; envFile: string; credentials: string; home?: string }): ModeFinding[] {
  const home = kosHome(options.home);
  const named = ["KOS_DEVICE_KEY_FILE", "KOS_DEVICE_LOCAL_KEY_FILE", "KOS_DEVICE_LAN_CERT_FILE", "KOS_APNS_KEY_FILE", "KOS_WRITE_KEY_FILE"]
    .map((name) => options.env[name]?.trim())
    .filter((path): path is string => !!path);
  const vault = options.env.KOS_VAULT_DIR?.trim() || join(home, "secrets");
  const folders = [...OWN_DIRS.map((sub) => join(home, sub)), vault, options.credentials];
  const files = [options.envFile, ...named, ...folders.filter((f) => f !== vault).flatMap(filesIn)];
  const findings: ModeFinding[] = [];
  const check = (path: string, fix: string): void => {
    if (!existsSync(path)) return;
    const mode = lstatSync(path).mode;
    if (mode & 0o077) findings.push({ path, detail: `${opened(mode)}, open to others: ${fix} ${path}` });
  };
  for (const folder of new Set(folders)) check(folder, "chmod 700");
  for (const file of new Set(files)) check(file, "chmod 600");
  return findings;
}

/** The regular files directly in `dir`, none when it is not there. */
function filesIn(dir: string): string[] {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => lstatSync(path).isFile());
}

/**
 * Folders whose contents a sync client may copy off the machine, by path
 * alone: iCloud Drive, the File Provider clients (Dropbox, Google Drive,
 * OneDrive, Box), their older home folders, and Desktop and Documents, which
 * macOS syncs to iCloud when "Desktop & Documents Folders" is on. Which of
 * those it is cannot be told without asking iCloud, which could prompt.
 */
const SYNCED = [
  ["Library/Mobile Documents", "iCloud Drive"],
  ["Library/CloudStorage", "a cloud storage client"],
  ["Dropbox", "Dropbox"],
  ["Google Drive", "Google Drive"],
  ["OneDrive", "OneDrive"],
  ["Box", "Box"],
  ["Desktop", "Desktop, which iCloud syncs when Desktop & Documents Folders is on"],
  ["Documents", "Documents, which iCloud syncs when Desktop & Documents Folders is on"],
] as const;

/** What may sync `path` off the machine, said for the owner; undefined for none known. */
export function syncedFolder(path: string, home = homedir()): string | undefined {
  const rel = relative(resolve(home), resolve(path));
  if (rel === "" || rel.startsWith("..") || rel.startsWith(sep)) return undefined;
  return SYNCED.find(([folder]) => rel === folder || rel.startsWith(`${folder}${sep}`))?.[1];
}

/**
 * Transcripts Claude Code kept of KOS's work before KOS turned them off
 * (builds kept one until then): under ~/.kos/claude, and under the owner's
 * ~/.claude for the workspace's folders. Each holds tool results no
 * scrubber saw. Listed, never deleted: what is in ~/.claude is the owner's.
 */
export function leftoverTranscripts(workspace: string, home = homedir()): string[] {
  const key = resolve(workspace).replace(/[^a-zA-Z0-9]/g, "-");
  const kept = (projects: string, mine: (name: string) => boolean): string[] =>
    existsSync(projects)
      ? readdirSync(projects)
          .filter(mine)
          .flatMap((name) => filesIn(join(projects, name)).filter((path) => path.endsWith(".jsonl")))
      : [];
  return [...kept(join(kosHome(home), "claude", "projects"), () => true), ...kept(join(home, ".claude", "projects"), (name) => name === key || name.startsWith(`${key}-`))];
}
