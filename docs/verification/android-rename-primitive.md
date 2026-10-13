# Android rename primitive: 13 October 2026

Executed in the disposable **Vault Sync Lab**, official Obsidian 1.14.4 on the Android 15 emulator. The production sync plugin was disabled during this probe. No personal vault files were used.

Source: `plugin/test/native/rename-probe.ts`. Build: `node scripts/build-native-rename-probe.mjs`. Install only in the named lab vault. The probe creates unique synthetic files and retains both versions for inspection. A completed report prevents an accidental repeat.

[Captured report](android-rename-primitive.json) contains four passing checks:

- Moving an 8 MiB file to a hidden holding directory preserves its exact SHA-256 and removes the source path.
- Moving the staged replacement into place preserves its exact SHA-256.
- Attempting to rename the held original onto the occupied destination fails and leaves both versions intact.
- After the host processes file events, the newly installed file is readable through Obsidian's visible vault index.

The original `TFile` object is retargeted to the hidden holding path. Obsidian emits a rename to that path, followed by a delete event for the hidden file. Installing the replacement emits a create event and produces a visible `TFile` at the original path. A plugin holding the old object can therefore still refer to the held file. Native transactions must retain unexpected held bytes, and internal recovery renames must not transfer the user's logical file-mode metadata.

These observations establish the behavior of completed adapter calls on this emulator. They do **not** prove atomicity under process death or power loss, durability ordering, behavior on physical Android storage providers, or open-editor compatibility. Those remain separate acceptance checks for the integrated transaction implementation.
