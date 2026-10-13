/** Adopt a vault that already has a `.git` folder: move the whole folder aside, unchanged,
 * into the plugin's excluded area. Never deletes, never runs Git, never touches notes or GitHub. */

/** Subset of Obsidian's DataAdapter; `app.vault.adapter` satisfies it. */
export interface TakeoverFiles {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ type: "file" | "folder" } | null>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  write(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export type BlockCode = "git-link" | "linked-worktrees" | "git-busy" | "git-mid-operation" | "interrupted";
type Blocked = { kind: "blocked"; code: BlockCode; reason: string };
export type GitTakeoverCheck = { kind: "none" } | { kind: "ready"; resume: boolean } | Blocked;
export type GitTakeoverResult = { kind: "none" } | { kind: "moved"; keptAt: string } | Blocked;

const GIT = ".git";
const ROOT = ".git-vault-sync/previous-git";
const KEPT = "dot-git";
const MID_OPERATION = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply", "sequencer"];

const blocked = (code: BlockCode, reason: string): Blocked => ({ kind: "blocked", code, reason });

/** Pending = a takeover that wrote `started` but not `done`. At most one may exist. */
async function pending(files: TakeoverFiles): Promise<string[]> {
  if ((await files.stat(ROOT))?.type !== "folder") return [];
  const result: string[] = [];
  for (const folder of (await files.list(ROOT)).folders) {
    if (await files.exists(`${folder}/started`) && !(await files.exists(`${folder}/done`))) result.push(folder);
  }
  return result;
}

async function findLock(files: TakeoverFiles, folder: string): Promise<string | null> {
  const listed = await files.list(folder);
  const lock = listed.files.find(path => path.endsWith(".lock"));
  if (lock) return lock;
  for (const child of listed.folders) {
    const found = await findLock(files, child);
    if (found) return found;
  }
  return null;
}

async function checkGitFolder(files: TakeoverFiles): Promise<Blocked | null> {
  if (await files.exists(`${GIT}/commondir`))
    return blocked("git-link", "This vault's Git folder belongs to another folder's Git setup. Open that original folder in Obsidian instead, then try again.");
  if ((await files.stat(`${GIT}/worktrees`))?.type === "folder" && (await files.list(`${GIT}/worktrees`)).folders.length)
    return blocked("linked-worktrees", "Other folders on this computer use this vault's Git setup. Remove them with Git (git worktree remove), then try again.");
  if ((await files.stat(`${GIT}/modules`))?.type === "folder") {
    const modules = await files.list(`${GIT}/modules`);
    if (modules.files.length || modules.folders.length)
      return blocked("git-link", "This vault contains Git submodules, which this plugin cannot sync. Keep using Obsidian Git for this vault.");
  }
  for (const entry of MID_OPERATION) if (await files.exists(`${GIT}/${entry}`))
    return blocked("git-mid-operation", "Git is partway through a merge or rebase in this vault. Finish or cancel it in Git, then try again.");
  const top = (await files.list(GIT)).files.find(path => path.endsWith(".lock"));
  const lock = top ?? ((await files.stat(`${GIT}/refs`))?.type === "folder" ? await findLock(files, `${GIT}/refs`) : null);
  if (lock)
    return blocked("git-busy", `Another app is using Git in this vault. Close other Git tools and try again. If nothing else is open, delete ${lock} and try again.`);
  return null;
}

/** Read-only. */
export async function inspectGitTakeover(files: TakeoverFiles): Promise<GitTakeoverCheck> {
  const interrupted = (where: string) => blocked("interrupted", `An earlier attempt to set aside your previous Git setup didn't finish. Keep both .git and ${where} as they are until this is resolved.`);
  const open = await pending(files);
  if (open.length > 1) return interrupted(ROOT);
  const git = await files.stat(GIT);
  const kept = open[0] && await files.exists(`${open[0]}/${KEPT}`);
  if (open[0] && kept) return git ? interrupted(open[0]) : { kind: "ready", resume: true };
  if (!git) return { kind: "none" };
  if (git.type === "file")
    return blocked("git-link", "This vault's Git setup lives in another folder. Open that original folder in Obsidian instead, then try again.");
  return (await checkGitFolder(files)) ?? { kind: "ready", resume: open.length === 1 };
}

const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/** Idempotent: safe to call again after any crash. Re-inspects before acting. */
export async function takeOverGit(files: TakeoverFiles, options: { now?: () => Date } = {}): Promise<GitTakeoverResult> {
  const check = await inspectGitTakeover(files);
  if (check.kind !== "ready") return check;
  const now = options.now ?? (() => new Date());
  let folder = (await pending(files))[0];
  if (!folder) {
    folder = `${ROOT}/${stamp(now())}-${crypto.randomUUID().slice(0, 4)}`;
    if (await files.exists(folder)) throw new Error("Try again in a moment.");
    for (const directory of [".git-vault-sync", ROOT, folder]) {
      if (!(await files.exists(directory))) await files.mkdir(directory);
    }
    await files.write(`${folder}/started`, JSON.stringify({ from: GIT, to: `${folder}/${KEPT}`, at: now().toISOString() }));
  }
  const keptAt = `${folder}/${KEPT}`;
  if (!(await files.exists(keptAt))) {
    try { await files.rename(GIT, keptAt); }
    catch {
      throw new Error(`Couldn't move the old Git folder. Close apps using Git in this vault, then try again. Keep .git and ${keptAt} as they are.`);
    }
  }
  if (await files.exists(GIT) || (await files.stat(keptAt))?.type !== "folder")
    throw new Error(`The old Git folder could not be moved completely. Keep .git and ${keptAt} as they are.`);
  await files.write(`${folder}/done`, JSON.stringify({ at: now().toISOString() }));
  return { kind: "moved", keptAt };
}
