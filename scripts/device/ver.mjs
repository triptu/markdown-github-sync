export default async ({ evaluate }) => {
  console.log(await evaluate(`(() => { const m = app.plugins; return { running: m.plugins['github-vault-sync']?.manifest?.version, loaded: !!m.plugins['github-vault-sync'], status: m.plugins['github-vault-sync']?.statusText, notices: [...document.querySelectorAll('.notice')].map(n => n.textContent) }; })()`));
};
