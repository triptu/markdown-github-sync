import {createRequire} from 'node:module';import{mkdir,writeFile}from'node:fs/promises';
const require=createRequire(new URL('../plugin/package.json',import.meta.url));
await mkdir('dist/native-integration',{recursive:true});
await require('esbuild').build({entryPoints:['plugin/test/native/integration.ts'],bundle:true,platform:'browser',format:'cjs',external:['obsidian'],outfile:'dist/native-integration/main.js'});
await writeFile('dist/native-integration/manifest.json',JSON.stringify({id:'git-sync-native-integration',name:'Git Sync Native Integration',version:'0.0.1',minAppVersion:'1.11.4',description:'Synthetic vault only',author:'Vault Sync',isDesktopOnly:false}));
