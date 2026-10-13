# Android primitive checks

Obsidian 1.14.4 official APK, Android 15 ARM64 emulator `lb_pixel_35`, synthetic vault `Vault Sync Lab`. No personal vault content or real credentials were used. Probe source: `plugin/test/native/probe.ts`, build: `node scripts/build-native-probe.mjs`. Install the generated probe as a community plugin only in the named synthetic vault.

Verified in native Obsidian: unauthenticated GitHub requestUrl, SecretStorage roundtrip, checksummed append-only journal persistence, stale local snapshot refusal, atomic Markdown apply, BOM/CRLF exact binary preservation, refusal of unsafe trash, and 4,321,024-byte attachment capture. Force-stopped the app and restarted: journal state and the synthetic secret persisted.

Evidence: `android-native-primitives.json`, `android-text-behavior.json`, `android-restart.json`.

During probe calibration, a BOM assertion using `vault.read` failed: that API returned the text without its BOM. Direct bytes on disk and `vault.readBinary` both retained it. The corrected assertion checks binary bytes. A later probe assertion used an outdated expected snapshot after deliberately applying a newer version; that refusal was correct and the probe was corrected to use the current version. These probe errors were not counted as passed tests.

This does not establish survival of power loss, OS storage eviction, arbitrary external writers, physical-phone behavior, or background execution. GitHub authentication and complete production plugin flows are separate checks.

## Automatic foreground integration

`android-foreground.json` records a production-plugin run against the synthetic branch `native-android-1791894436601`. After a desktop-side commit added `Automatic Laptop.md`, the native test added a different `Automatic Phone.md`. Automatic foreground scheduling downloaded the committed laptop file and published the phone file without calling Sync now. Both exact file contents were independently read back from GitHub at commit `0d7564b20418cccac840d50ed80257516abae628`.

The first run failed with `Illegal invocation`: storing bare browser timer functions on the scheduler clock caused an invalid receiver when called as methods. Arrow wrappers fixed the native failure. The successful run used the engine-r2 build with that focused timer fix; its artifact hash is recorded. That early result is superseded by the combined-build check below. This is emulator evidence, not physical-phone acceptance.

## Combined build acceptance candidate

`android-foreground-final-r2.json` records the current core-r6 and native mode recovery build (SHA-256 recorded in the evidence). It loaded the prior installation journal after upgrade, downloaded `Final r2 Laptop.md`, and automatically committed `Final r2 Phone.md` without Sync now. Both files were independently read from GitHub at the resulting commit and matched their exact expected bytes. The observed 8.5-second completion is one functional run, not a latency benchmark.

The earlier `final-r1` artifact predates the last core and mode recovery fixes. Final-r2 is an intermediate emulator result. It is superseded by the final artifact acceptance in [android-conflict.md](android-conflict.md), which includes automatic sync across restart and conflict/recovery checks. All authenticated integration runs used the synthetic private repository and a credential stored in Obsidian SecretStorage. The primitive-only run above used a synthetic secret.
