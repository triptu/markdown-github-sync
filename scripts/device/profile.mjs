export default async ({ send, evaluate, fs }) => {
  await send("Profiler.enable"); await send("Profiler.setSamplingInterval", { interval: 500 });
  await evaluate(`window.__lt = []; window.__ltObs?.disconnect(); window.__ltObs = new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push([Math.round(e.startTime), Math.round(e.duration)]); }); window.__ltObs.observe({ type: "longtask", buffered: false }); true`);
  await send("Profiler.start");
  const r = await evaluate(`(async () => { const p = app.plugins.plugins['github-vault-sync']; const t0 = performance.now(); await p.syncNow(); return { ms: Math.round(performance.now() - t0), status: p.statusText }; })()`);
  const { profile } = await send("Profiler.stop");
  const lt = await evaluate(`window.__lt`);
  console.log("sync", r); console.log("long tasks (start,ms):", JSON.stringify(lt), "total", lt.reduce((a, b) => a + b[1], 0));
  fs.writeFileSync(process.env.OUT || "sync.cpuprofile", JSON.stringify(profile));
  // self time by function
  const self = new Map(); const byId = new Map(profile.nodes.map(n => [n.id, n]));
  const dt = profile.timeDeltas; let total = 0;
  profile.samples.forEach((s, i) => { const n = byId.get(s); const k = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) || 0) + (dt[i] || 0)); total += dt[i] || 0; });
  const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log("profile total ms", Math.round(total / 1000));
  for (const [k, v] of top) console.log(String(Math.round(v / 1000)).padStart(6), k);
};
