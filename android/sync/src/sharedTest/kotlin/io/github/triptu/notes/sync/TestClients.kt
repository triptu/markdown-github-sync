package io.github.triptu.notes.sync

import java.io.File

/** A client over its own [VaultFiles] in [vaultDir]; the app shares one with its store instead. */
fun SyncClient(
    storageDir: File,
    vaultDir: File,
    config: SyncConfig,
    tokens: TokenProvider,
    engineScript: String,
    clock: () -> Long = System::currentTimeMillis,
): SyncClient = SyncClient(storageDir, VaultFiles(vaultDir), config, tokens, engineScript, clock)
