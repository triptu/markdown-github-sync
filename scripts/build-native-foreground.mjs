import {createRequire} from 'node:module';import{mkdir,writeFile}from'node:fs/promises';
const require=createRequire(new URL('../plugin/package.json',import.meta.url));
await mkdir('dist/native-foreground',{recursive:true});
await require('esbuild').build({entryPoints:['plugin/test/native/foreground.ts'],bundle:true,platform:'browser',format:'cjs',external:['obsidian'],outfile:'dist/native-foreground/main.js'});
await writeFile('dist/native-foreground/manifest.json',JSON.stringify({id:'git-sync-native-foreground',name:'Git Sync Foreground Verification',version:'0.0.1',minAppVersion:'1.11.4',description:'Synthetic vault only',author:'Vault Sync',isDesktopOnly:false}));
