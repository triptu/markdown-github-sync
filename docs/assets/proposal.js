const situations = {
  different: {
    index: "01 / 05",
    title: "Two devices edit different files",
    intro: "The laptop changes one note; the phone changes another. Both start from the same committed version.",
    verdict: "Both edits can join the history.",
    steps: [
      "Each saved edit is a draft on its own device.",
      "The first accepted commit moves the branch; the next device compares that new head before publishing.",
      "Sequential, independent edits converge. A truly simultaneous publication can pause for reviewed recovery."
    ],
    footnote: "Automatic sync runs after saved edits, on foreground return, and periodically while Obsidian is open. “Sync now” is also available.",
    caution: false
  },
  offline: {
    index: "02 / 05",
    title: "You write without a connection",
    intro: "Obsidian continues saving files locally. The last accepted GitHub commit remains the shared version.",
    verdict: "The draft waits on this device.",
    steps: [
      "Your saved bytes and local checkpoint remain available while offline.",
      "On reconnection, foreground sync compares the draft with the current GitHub head and prepares a commit if it is safe.",
      "Other devices receive the edit only after GitHub accepts the commit. A suspended Android app does not promise background delivery."
    ],
    footnote: "The status must show content synced before relying on the change from another device.",
    caution: true
  },
  conflict: {
    index: "03 / 05",
    title: "Both devices change the same file",
    intro: "Two different drafts diverge from a common committed version of the same note.",
    verdict: "Only this file needs a decision.",
    steps: [
      "The plugin retains the local draft and identifies the common and GitHub versions.",
      "The conflict inbox previews the versions and lets you keep either, keep both, or edit merged Markdown.",
      "A reviewed decision is checked against the current head before publication. Other independent files need no whole-vault choice."
    ],
    footnote: "Existing binary replacement and incoming deletion can require a native hold or explicit review. The plugin does not text-merge attachments.",
    caution: true
  },
  crash: {
    index: "04 / 05",
    title: "The app stops mid-sync",
    intro: "A native write or GitHub publication can finish just as the process disappears.",
    verdict: "Recovery follows durable evidence.",
    steps: [
      "Before an incoming replacement, the native journal pins the original bytes in a preimage hold.",
      "For an uncertain upload, the per-installation ledger receipt or seal settles whether its candidate was accepted or cancelled.",
      "On restart, the plugin resumes or pauses with recoverable bytes. It does not infer a deletion from a missing file or repeat an uncertain publication."
    ],
    footnote: "Current-bundle normal restart checks passed. Current-bundle process-kill boundary checks are still pending.",
    caution: true
  },
  config: {
    index: "05 / 05",
    title: "You choose to include configuration",
    intro: "Hidden Obsidian settings can affect a live workspace, so they cross a separate review boundary.",
    verdict: "Scope changes require deliberate consent.",
    steps: [
      "A legacy visible-file enrollment stays in its existing mode until you review a configuration policy upgrade.",
      "Incoming live configuration is deferred. New hidden local files need exact consent before they can publish.",
      "Ignore rules and built-in protected paths are rechecked, while credentials, caches, and recovery state remain excluded."
    ],
    footnote: "The current Android run exercised legacy visible-file mode. Configuration UI and migration on Android remain acceptance work.",
    caution: true
  }
};

const buttons = [...document.querySelectorAll("[data-scenario]")];
const stage = document.querySelector(".scenario-stage");
const ids = {
  index: document.getElementById("scenario-index"),
  title: document.getElementById("scenario-title"),
  intro: document.getElementById("scenario-intro"),
  verdict: document.getElementById("scenario-verdict"),
  steps: [
    document.getElementById("scenario-step-one"),
    document.getElementById("scenario-step-two"),
    document.getElementById("scenario-step-three")
  ],
  footnote: document.getElementById("scenario-footnote")
};
function show(key) {
  const value = situations[key];
  if (!value) return;
  for (const button of buttons) button.setAttribute("aria-pressed", String(button.dataset.scenario === key));
  ids.index.textContent = value.index;
  ids.title.textContent = value.title;
  ids.intro.textContent = value.intro;
  ids.verdict.textContent = value.verdict;
  value.steps.forEach((text, index) => { ids.steps[index].textContent = text; });
  ids.footnote.textContent = value.footnote;
  stage.classList.toggle("caution", value.caution);
}
for (const button of buttons) button.addEventListener("click", () => show(button.dataset.scenario));
