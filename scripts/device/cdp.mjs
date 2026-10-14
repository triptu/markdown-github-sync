// Minimal CDP client: node cdp.mjs <wsUrl> <script.mjs>. The script exports default async ({ send, evaluate, fs }).
import fs from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [ws, file] = process.argv.slice(2);
const sock = new WebSocket(ws);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); sock.send(JSON.stringify({ id: i, method, params })); });
sock.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
await new Promise(r => sock.onopen = r);
const evaluate = async (expr, awaitPromise = true) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result.value; };
const mod = await import(pathToFileURL(resolve(file)).href);
await mod.default({ send, evaluate, fs });
sock.close(); process.exit(0);
