export default async ({ evaluate }) => {
  console.log(await evaluate(`(() => { const p = app.plugins.plugins['github-vault-sync']; const s = p.scheduler; return { status: p.statusText, automatic: p.settings.automatic, ready: p.ready, session: !!p.session, hidden: document.hidden, sched: s && { running: s.running, timer: s.timer !== null, pending: s.pending, failures: s.failures, retryAfter: s.retryAfter - Date.now(), stopped: s.stopped, editedSince: s.editedSince } }; })()`));
};
