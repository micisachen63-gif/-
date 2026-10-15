import fs from 'node:fs';
import path from 'node:path';

// One synchronous atomic writer per service; never put credentials in this file.
export class BridgeState {
  constructor(file) {
    this.file=file;
    this.data=file&&fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{sessions:{},jobs:{},choices:{}};
    this.data.sessions??={};this.data.jobs??={};this.data.choices??={};
  }
  save(){if(!this.file)return;fs.mkdirSync(path.dirname(this.file),{recursive:true});const temp=this.file+'.tmp';fs.writeFileSync(temp,JSON.stringify(this.data,null,2));fs.renameSync(temp,this.file);}
  session(key){return this.data.sessions[key]??null;}
  setSession(key,value){this.data.sessions[key]={...this.data.sessions[key],...value};this.save();}
  job(userId){return this.data.jobs[String(userId)]??null;}
  setJob(userId,value){this.data.jobs[String(userId)]=value;this.save();}
}
