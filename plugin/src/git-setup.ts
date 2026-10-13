export interface GitSetupFiles {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
}
export interface DetectedRepository { owner: string; repository: string; branch: string }

export function tokenCreationUrl(owner: string): string {
  const url = new URL("https://github.com/settings/personal-access-tokens/new");
  url.searchParams.set("name", "Obsidian GitHub Vault Sync");
  url.searchParams.set("description", "Sync my Obsidian vault with GitHub");
  url.searchParams.set("contents", "write");
  url.searchParams.set("metadata", "read");
  if (owner) url.searchParams.set("target_name", owner);
  return url.href;
}

/** Reads only ordinary in-vault Git metadata; linked worktrees remain manual setup. */
export async function detectGitRepository(files: GitSetupFiles): Promise<DetectedRepository | null> {
  if (!(await files.exists(".git/config")) || !(await files.exists(".git/HEAD"))) return null;
  const head = (await files.read(".git/HEAD")).trim();
  const localBranch = /^ref: refs\/heads\/(.+)$/.exec(head)?.[1];
  if (!localBranch) return null;
  const remotes = new Map<string, string>();
  const upstreams = new Map<string, { remote?: string; branch?: string }>();
  let section: { kind: "remote" | "branch"; name: string } | null = null;
  for (const raw of (await files.read(".git/config")).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      const match = /^\[(remote|branch)\s+"([^"\\]+)"\]$/i.exec(line);
      section = match ? { kind: match[1].toLowerCase() === "remote" ? "remote" : "branch", name: match[2] } : null;
      continue;
    }
    const field = /^(url|remote|merge)\s*=\s*(.*?)\s*$/i.exec(line);
    if (!section || !field) continue;
    const key = field[1].toLowerCase();
    const value = field[2].replace(/^"(.*)"$/, "$1");
    if (section.kind === "remote" && key === "url") remotes.set(section.name, value);
    if (section.kind === "branch") {
      const upstream = upstreams.get(section.name) ?? {};
      if (key === "remote") upstream.remote = value;
      if (key === "merge" && value.startsWith("refs/heads/")) upstream.branch = value.slice("refs/heads/".length);
      upstreams.set(section.name, upstream);
    }
  }
  const upstream = upstreams.get(localBranch);
  const remote = remotes.get(upstream?.remote ?? "origin");
  if (!remote) return null;
  let repoPath: string;
  const ssh = /^git@github\.com:([^\s]+)$/i.exec(remote);
  if (ssh) repoPath = ssh[1];
  else {
    let url: URL;
    try { url = new URL(remote); } catch { return null; }
    if (url.hostname.toLowerCase() !== "github.com" || !["https:", "ssh:"].includes(url.protocol)) return null;
    repoPath = url.pathname.replace(/^\//, "");
  }
  const match = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(repoPath);
  if (!match) return null;
  return { owner: match[1], repository: match[2], branch: upstream?.branch ?? localBranch };
}
