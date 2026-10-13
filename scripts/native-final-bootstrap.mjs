import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";

const owner = "triptu";
const repository = "vault-sync-test";
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const mode = process.argv[2];
const runPath = process.argv[3];
const device = process.argv[4];
if (!(mode === "create" && process.argv.length === 4 ||
      mode === "serve" && ["desktop", "android"].includes(device) && process.argv.length === 5) ||
    !new RegExp(`^dist/native-final-acceptance/${uuid}/run\\.json$`).test(runPath ?? ""))
  throw new Error("Usage: node scripts/native-final-bootstrap.mjs create <dist/.../run.json> | serve <dist/.../run.json> <desktop|android>");

const run = JSON.parse(await readFile(runPath, "utf8"));
if (run.format !== 1 || !new RegExp(`^${uuid}$`).test(run.runId) ||
    run.branch !== `native-final-${run.runId}` ||
    runPath !== `dist/native-final-acceptance/${run.runId}/run.json` ||
    !/^[0-9a-f]{64}$/.test(run.expectedProductionSha256)) throw new Error("Invalid final run manifest");
let token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
if (!token) throw new Error("GitHub credential unavailable");
async function api(path, body) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repository}${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`GitHub lab setup HTTP ${response.status}`);
  return response.json();
}
const metadata = await api("");
if (metadata.private !== true || metadata.name !== repository || metadata.owner?.login?.toLowerCase() !== owner)
  throw new Error("Refusing non-private or wrong lab repository");

if (mode === "create") {
  if (run.seed) throw new Error("This run already has a branch; build a fresh run instead");
  const before = await api(`/git/ref/heads/${metadata.default_branch}`);
  const note = await api("/git/blobs", { content: `Final acceptance seed ${run.runId}\n`, encoding: "utf-8" });
  const tree = await api("/git/trees", { tree: [{ path: `Final Acceptance ${run.runId}/Seed.md`, type: "blob", mode: "100644", sha: note.sha }] });
  const commit = await api("/git/commits", { message: `Synthetic final acceptance seed ${run.runId}`, tree: tree.sha, parents: [before.object.sha] });
  await api("/git/refs", { ref: `refs/heads/${run.branch}`, sha: commit.sha });
  run.seed = commit.sha;
  await writeFile(runPath, JSON.stringify(run, null, 2) + "\n");
  token = "";
  console.log(`Private synthetic branch created: ${run.branch}; seed ${commit.sha}`);
} else {
  if (!/^[0-9a-f]{40}$/.test(run.seed ?? "")) throw new Error("Create this run's branch first");
  const ref = await api(`/git/ref/heads/${run.branch}`);
  if (ref.ref !== `refs/heads/${run.branch}` || !/^[0-9a-f]{40}$/.test(ref.object?.sha ?? ""))
    throw new Error("Final branch unavailable before provisioning");
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== `/bootstrap/${run.runId}/${device}`) {
      response.writeHead(404).end(); return;
    }
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    response.end(JSON.stringify({ owner, repository, branch: run.branch, runId: run.runId, device, token }));
    token = "";
    server.close();
    clearTimeout(timeout);
  });
  server.listen(37921, "127.0.0.1", () =>
    console.log(`One-use ${device} provisioning ready on loopback port 37921; credential is not logged.`));
  const timeout = setTimeout(() => { token = ""; server.close(); }, 300_000);
}
