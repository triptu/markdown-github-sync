import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const point = process.argv[2];
if (!['displace', 'install'].includes(point)) throw new Error('Choose displace or install');
const require = createRequire(new URL('../plugin/package.json', import.meta.url));
await mkdir('dist/native-crash', { recursive: true });
await require('esbuild').build({ entryPoints: ['plugin/test/native/crash-acceptance.ts'], bundle: true,
  platform: 'browser', format: 'cjs', external: ['obsidian'], outfile: 'dist/native-crash/main.js',
  define: { CRASH_POINT: JSON.stringify(point), EXPECTED_PRODUCTION_SHA: JSON.stringify(createHash('sha256').update(await readFile('dist/github-vault-sync/main.js')).digest('hex')) } });
await writeFile('dist/native-crash/manifest.json', JSON.stringify({ id: 'git-sync-native-crash', name: 'Git Sync Native Crash Acceptance',
  version: '0.0.1', minAppVersion: '1.11.4', description: 'Disposable lab process-kill verification only', author: 'Vault Sync', isDesktopOnly: false }));
