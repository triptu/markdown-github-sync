export default async ({ evaluate }) => {
  const r = await evaluate(`(async () => {
    const p = app.plugins.plugins['github-vault-sync'];
    const errs = [];
    const orig = p.fail.bind(p);
    p.fail = (e) => { errs.push({ msg: String(e?.message ?? e), name: e?.name, status: e?.status, stack: String(e?.stack ?? '').slice(0, 1500) }); return orig(e); };
    try { const t0 = performance.now(); await p.syncNow(); return { ms: Math.round(performance.now() - t0), status: p.statusText, errs, online: navigator.onLine }; }
    finally { p.fail = orig; }
  })()`);
  console.log(JSON.stringify(r, null, 2));
};
