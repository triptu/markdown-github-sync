// Obsidian's plugin directory reads manifest.json and versions.json from the default branch,
// so every version field must agree and the version must be plain x.y.z.
import { readFile } from "node:fs/promises";

const read = async path => JSON.parse(await readFile(path, "utf8"));
const manifest = await read("manifest.json");
const versions = await read("versions.json");
const lock = await read("package-lock.json");
const found = {
  "package.json": (await read("package.json")).version,
  "plugin/package.json": (await read("plugin/package.json")).version,
  "package-lock.json": lock.packages[""].version,
  "package-lock.json (plugin)": lock.packages.plugin.version,
};
const problems = [];
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) problems.push(`manifest.json version ${manifest.version} isn't plain x.y.z.`);
for (const [file, version] of Object.entries(found))
  if (version !== manifest.version) problems.push(`${file} has ${version}, manifest.json has ${manifest.version}.`);
if (versions[manifest.version] !== manifest.minAppVersion)
  problems.push(`versions.json should map ${manifest.version} to ${manifest.minAppVersion}.`);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`Release metadata agrees on ${manifest.version}.`);
