import { readFile, writeFile, mkdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
let css = await readFile(new URL("docs/assets/proposal.css", root), "utf8");
for (const match of [...css.matchAll(/url\(([^)]+\.woff2)\)/g)]) {
  const font = await readFile(new URL(`docs/assets/${match[1]}`, root));
  css = css.replace(
    match[0],
    `url(data:font/woff2;base64,${font.toString("base64")})`,
  );
}
const script = await readFile(new URL("docs/assets/proposal.js", root), "utf8");
const source = await readFile(
  new URL("docs/github-sync-proposal.html", root),
  "utf8",
);
const html = source
  .replace(
    '<link rel="stylesheet" href="assets/proposal.css" />',
    () => `<style>${css}</style>`,
  )
  .replace(
    '<script src="assets/proposal.js"></script>',
    () => `<script>${script}</script>`,
  )
  .replace(
    /href="((?:verification\/)?[^"/]+\.md)"/g,
    (_, path) => `href="https://github.com/triptu/cloud-vault-sync/blob/main/docs/${path}"`,
  );
await mkdir(new URL("dist/", root), { recursive: true });
await writeFile(new URL("dist/github-sync-proposal.html", root), html);
console.log(
  "Exported dist/github-sync-proposal.html with embedded fonts, styles, and interactions.",
);
