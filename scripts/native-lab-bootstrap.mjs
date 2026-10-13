import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
const owner='triptu', repository='vault-sync-test';
let token=execFileSync('gh',['auth','token'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
const branch=`native-android-${Date.now()}`;
async function api(path,body){const response=await fetch(`https://api.github.com/repos/${owner}/${repository}${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});if(!response.ok)throw new Error(`GitHub lab setup HTTP ${response.status}`);return response.json();}
const metadata=await api('');const before=await api(`/git/ref/heads/${metadata.default_branch}`);
const note=await api('/git/blobs',{content:'Shared base\n',encoding:'utf-8'});
const tree=await api('/git/trees',{tree:[{path:'Shared.md',type:'blob',mode:'100644',sha:note.sha},{path:'.obsidian/lab-config.json',type:'blob',mode:'100644',sha:note.sha}]});
const commit=await api('/git/commits',{message:'Synthetic native Android integration seed',tree:tree.sha,parents:[before.object.sha]});
await api('/git/refs',{ref:`refs/heads/${branch}`,sha:commit.sha});
await mkdir('docs/verification',{recursive:true});await writeFile('docs/verification/native-lab-config.json',JSON.stringify({owner,repository,branch,seed:commit.sha,defaultHead:before.object.sha},null,2));
const server=createServer((request,response)=>{if(request.method!=='GET'||request.url!=='/bootstrap'){response.writeHead(404).end();return;}response.setHeader('Content-Type','application/json');response.setHeader('Cache-Control','no-store');response.end(JSON.stringify({owner,repository,branch,token}));token='';server.close();clearTimeout(timeout);});
server.listen(37921,'127.0.0.1',()=>console.log('One-use native lab bootstrap ready on loopback port 37921. Credential is not logged.'));
const timeout=setTimeout(()=>{token='';server.close();},300000);
