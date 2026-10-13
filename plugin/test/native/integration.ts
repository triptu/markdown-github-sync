import { Plugin, requestUrl, TFile } from "obsidian";
import type GitVaultSync from "../../src/main";
export default class NativeIntegration extends Plugin {
  onload() { this.app.workspace.onLayoutReady(()=>{setTimeout(()=>{void this.run();},1500);}); }
  async run() {
    if(this.app.vault.getName()!=="Vault Sync Lab")return;
    const files=this.app.vault.adapter;
    if(await files.exists('.git-sync-native-integration.json'))return;
    const results: {name:string;pass:boolean}[]=[];
    const check=(name:string,pass:boolean)=>{results.push({name,pass});if(!pass)throw new Error(name);};
    try {
      const response=await requestUrl({url:'http://127.0.0.1:37921/bootstrap'});
      const config:unknown=JSON.parse(response.text);
      if(typeof config!=='object'||config===null)throw new Error('Invalid bootstrap');
      const token:unknown=Reflect.get(config,'token'),branch:unknown=Reflect.get(config,'branch');
      if(typeof token!=='string'||typeof branch!=='string'||Reflect.get(config,'owner')!=='triptu'||Reflect.get(config,'repository')!=='vault-sync-test')throw new Error('Invalid synthetic repository target');
      this.app.secretStorage.setSecret('git-sync-native-lab',token);
      const manager:unknown=Reflect.get(this.app,'plugins');
      if(typeof manager!=='object'||manager===null)throw new Error('Plugin manager unavailable');
      const plugins:unknown=Reflect.get(manager,'plugins');
      if(typeof plugins!=='object'||plugins===null)throw new Error('Plugins unavailable');
      const candidate:unknown=Reflect.get(plugins,'github-vault-sync');
      if(typeof candidate!=='object'||candidate===null||typeof Reflect.get(candidate,'saveConfiguration')!=='function')throw new Error('Production plugin not enabled');
      const plugin=candidate as GitVaultSync;
      await plugin.saveConfiguration({format:2,owner:'triptu',repository:'vault-sync-test',branch,secretId:'git-sync-native-lab',deviceName:'Android emulator',automatic:true});
      if(!plugin.session)throw new Error('Session not initialized');
      const preview=await plugin.session.previewEnrollment();
      check('native enrollment preview',preview.kind==='preview');if(preview.kind!=='preview')return;
      check('explicit enrollment', (await plugin.session.enroll({token:preview.token})).kind==='enrolled');
      await plugin.syncOnce();
      const shared=this.app.vault.getAbstractFileByPath('Shared.md');
      check('committed note downloaded through native transport',shared instanceof TFile && await this.app.vault.read(shared)==='Shared base\n');
      if(!this.app.vault.getAbstractFileByPath('Phone.md'))await this.app.vault.create('Phone.md','Written on Android\n');
      await plugin.syncOnce();
      const status=await plugin.session.inspect();
      check('native edit committed and applied',status.kind==='enrolled'&&status.phase==='idle'&&status.pending?.length===0);
      const data=await files.read('.obsidian/plugins/github-vault-sync/data.json');
      check('settings contain secret identifier only',!data.includes(token)&&data.includes('git-sync-native-lab'));
      await files.write('.git-sync-native-integration.json',JSON.stringify({completed:true,results,branch,commit:status.kind==='enrolled'?status.commit:null,device:'Android15 emulator',obsidian:'1.14.4'}));
    }catch(error){await files.write('.git-sync-native-integration-error.json',JSON.stringify({results,error:error instanceof Error?error.message:'Native integration failed'}));}
  }
}
