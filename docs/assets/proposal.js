const scenarios = {
  normal: {
    titles: [
      "Save the draft",
      "Compare three versions",
      "Create the shared version",
      "Bring devices up to date",
    ],
    copy: [
      "Preserve the exact saved bytes before any remote changes arrive.",
      "Base commit, local draft, and the latest GitHub snapshot.",
      "Advance the branch only if its head still matches our plan.",
      "Apply the committed snapshot while preserving any newer drafts.",
    ],
    states: [
      "On this device",
      "Ready to publish",
      "Accepted on GitHub",
      "Content synced",
    ],
    summary:
      "The branch update is the publishing moment. Uploading files or saving a local note alone never counts as “synced.”",
  },
  offline: {
    titles: [
      "Keep writing",
      "Wait for connection",
      "Previous commit stays shared",
      "Other devices wait",
    ],
    copy: [
      "Obsidian saves your note. The plugin preserves a local draft.",
      "On reconnect, compare the draft with the latest committed version.",
      "No connection means no new accepted commit on GitHub.",
      "They keep their last committed version until publication succeeds.",
    ],
    states: [
      "Saved locally",
      "Waiting for connection",
      "No new commit",
      "Not yet shared",
    ],
    summary:
      "Offline editing works. Your new draft exists only on this device until a GitHub commit is accepted. Phones may suspend Obsidian in the background.",
  },
  race: {
    titles: [
      "Two drafts, one base",
      "First device publishes",
      "Stale writer is rejected",
      "Reconcile and retry",
    ],
    copy: [
      "The laptop and phone both prepare changes against commit A.",
      "The laptop’s commit B is accepted first.",
      "The phone expected A. It must not overwrite the now-current B.",
      "Combine compatible changes or ask you to resolve a conflict.",
    ],
    states: [
      "Laptop + phone",
      "A becomes B",
      "Expected A, found B",
      "No blind overwrite",
    ],
    summary:
      "An exact branch-head check protects publication. The losing device replans against the winning commit; it never forces its older plan onto the branch.",
  },
  missing: {
    titles: [
      "Folder looks empty",
      "Treat absence as unknown",
      "No deletion is published",
      "Review or recover",
    ],
    copy: [
      "A mount, startup scan, or external tool may have hidden files.",
      "Missing paths are not reliable evidence that you meant to delete.",
      "Pause the batch instead of turning an empty scan into a commit.",
      "Show affected paths and require an explicit deletion decision.",
    ],
    states: [
      "Unexpected absence",
      "Needs your review",
      "Branch unchanged",
      "Other devices safe",
    ],
    summary:
      "Even deletion events are only candidates. V1 reviews all deletions and never lets an unexplained missing folder erase another device.",
  },
};
document.querySelectorAll("[data-scenario]").forEach((button) =>
  button.addEventListener("click", () => {
    const data = scenarios[button.dataset.scenario];
    document
      .querySelectorAll("[data-scenario]")
      .forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
    for (let i = 0; i < 4; i++) {
      document.getElementById("phase-title-" + i).textContent = data.titles[i];
      document.getElementById("phase-copy-" + i).textContent = data.copy[i];
      document.getElementById("phase-state-" + i).textContent = data.states[i];
    }
    document.getElementById("scenario-summary").textContent = data.summary;
  }),
);
let choice = null,
  revision = 0;
const byId = (id) => document.getElementById(id);
const confirm = byId("confirm-resolution"),
  content = byId("result-content"),
  edit = byId("edit-wrap"),
  status = byId("resolution-status");
const remoteText = () =>
  `Meet on ${revision ? "Thursday" : "Wednesday"}.\nBring the sketches.`;
function choose(value) {
  choice = value;
  document
    .querySelectorAll("[data-choice]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.choice === value)),
    );
  byId("result-heading").textContent =
    value === "both" ? "TWO FILES WILL BE KEPT" : "RESULT PREVIEW";
  byId("result-state").textContent = "Not published";
  content.classList.remove("empty");
  content.hidden = value === "edit";
  edit.hidden = value !== "edit";
  content.textContent =
    value === "mine"
      ? "Meet on Tuesday.\nBring the sketches."
      : value === "remote"
        ? remoteText()
        : value === "both"
          ? `Meeting.md\n  ${revision ? "Thursday" : "Wednesday"} version from GitHub\n\nMeeting (my version).md\n  Tuesday version from this device`
          : "";
  status.textContent =
    "Both reviewed versions stay recoverable. The branch will be checked again before publication.";
  confirm.disabled = false;
  byId("resolver-badge").textContent = "Decision ready";
  byId("reset-demo").hidden = false;
}
document
  .querySelectorAll("[data-choice]")
  .forEach((button) =>
    button.addEventListener("click", () => choose(button.dataset.choice)),
  );
confirm.addEventListener("click", () => {
  if (!choice) return;
  if (choice === "edit") {
    content.textContent = byId("merged-text").value;
    content.hidden = false;
    edit.hidden = true;
  }
  byId("result-heading").textContent = "DEMO COMMIT ACCEPTED";
  byId("result-state").textContent = "Simulation only";
  byId("resolver-badge").textContent = "Resolved in demo";
  status.textContent =
    "The chosen result is now the simulated shared version. Any newer local edits remain a separate draft. No real files were changed.";
  confirm.disabled = true;
});
byId("move-remote").addEventListener("click", () => {
  revision = 1;
  choice = null;
  document
    .querySelectorAll("[data-choice]")
    .forEach((b) => b.setAttribute("aria-pressed", "false"));
  byId("remote-day").textContent = "Thursday.";
  byId("review-reference").textContent =
    "New GitHub commit d7e8f9a — review again";
  byId("result-heading").textContent = "PREVIOUS DECISION INVALIDATED";
  byId("result-state").textContent = "Publication paused";
  content.hidden = false;
  edit.hidden = true;
  content.classList.add("empty");
  content.textContent =
    "GitHub now says Thursday. Compare the updated version above and choose again.";
  status.textContent =
    "The remote version changed. A decision about the old version cannot authorize this write.";
  byId("resolver-badge").textContent = "Review newer version";
  confirm.disabled = true;
  byId("reset-demo").hidden = false;
});
byId("reset-demo").addEventListener("click", () => {
  choice = null;
  revision = 0;
  document
    .querySelectorAll("[data-choice]")
    .forEach((b) => b.setAttribute("aria-pressed", "false"));
  byId("remote-day").textContent = "Wednesday.";
  byId("review-reference").textContent = "Reviewing GitHub commit c4d5e6f";
  byId("result-heading").textContent = "RESULT PREVIEW";
  byId("result-state").textContent = "Choose a version above";
  content.hidden = false;
  edit.hidden = true;
  content.classList.add("empty");
  content.textContent =
    "Your decision will appear here. Nothing is sent to GitHub.";
  status.textContent = "No choice made. Your draft is unchanged.";
  byId("resolver-badge").textContent = "1 decision needed";
  confirm.disabled = true;
  byId("reset-demo").hidden = true;
});
