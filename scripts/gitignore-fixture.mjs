import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Synthetic names and patterns only. Keep this list reviewed: it must never
// read a user's vault or discover paths on the host.
const patterns = [
  "# root rules used by the synthetic vault",
  ".obsidian/cache/",
  ".obsidian/workspace",
  ".obsidian/plugins/vikalp/data.json",
  "*.tmp",
  "!important.tmp",
  "/root-only.md",
  "**/draft?.md",
  "\\#literal.md",
  "\\!literal.md",
  "trailing\\ ",
  "café.md",
  "Foo.txt",
  "ignored-parent/",
  "!ignored-parent/child.md",
  "open-parent/*",
  "!open-parent/child.md",
  ".gitignore",
  "",
].join("\n");

const cases = [
  ["notes.md", "plain content"],
  [".obsidian/app.json", "configuration file"],
  [".obsidian/plugins/vikalp/rules/.builtin-rules.json", "dotted filename in config"],
  [".obsidian/cache/index", "ignored config directory"],
  [".obsidian/cache/deep/index", "ignored config descendant"],
  [".obsidian/workspace", "ignored exact config path"],
  [".obsidian/workspace/file", "ignored parent directory"],
  [".obsidian/plugins/vikalp/data.json", "tracked-looking file ignored by policy"],
  ["draft.tmp", "glob"],
  ["docs/draft.tmp", "glob in subdirectory"],
  ["important.tmp", "negation"],
  ["docs/important.tmp", "negation in subdirectory"],
  ["root-only.md", "anchored root"],
  ["docs/root-only.md", "anchored nested"],
  ["draft1.md", "double-star root"],
  ["docs/deep/draft2.md", "double-star nested"],
  ["docs/deep/drafts.md", "question mark mismatch"],
  ["#literal.md", "escaped hash"],
  ["!literal.md", "escaped exclamation"],
  ["trailing ", "escaped trailing space"],
  ["trailing", "without trailing space"],
  ["café.md", "Unicode exact"],
  ["café.md", "Unicode decomposed"],
  ["Foo.txt", "case exact"],
  ["foo.txt", "case variant"],
  ["ignored-parent/child.md", "negation cannot reopen parent"],
  ["open-parent/other.md", "ignored child"],
  ["open-parent/child.md", "negated child"],
  [".gitignore", "control file override"],
];

const root = await mkdtemp(join(tmpdir(), "scope-gitignore-"));
try {
  const home = join(root, "home");
  await mkdir(home);
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "0",
  };
  execFileSync("git", ["init", "-q", root], { env });
  await writeFile(join(root, ".gitignore"), patterns, "utf8");
  const rows = cases.map(([path, description]) => {
    const result = spawnSync("git", ["-c", "core.ignorecase=false", "-c", "core.precomposeunicode=false",
      "-c", "core.excludesFile=/dev/null",
      "check-ignore", "--no-index", "--quiet", "--", path], { cwd: root, env, encoding: "utf8" });
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`git check-ignore failed for ${JSON.stringify(path)}: ${result.stderr}`);
    }
    return { path, description, ignored: result.status === 0 };
  });
  const fixture = {
    generator: "scripts/gitignore-fixture.mjs",
    oracle: "git check-ignore --no-index --quiet; core.ignorecase=false; core.precomposeunicode=false; no global/system excludes",
    patterns,
    rows,
  };
  const target = new URL("../plugin/test/fixtures/gitignore-conformance.json", import.meta.url);
  await writeFile(target, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
} finally {
  await rm(root, { recursive: true, force: true });
}
