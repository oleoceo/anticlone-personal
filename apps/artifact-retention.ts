import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,readFile,readdir,realpath,unlink,rmdir,open} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

type Policy={format:1;log_days:number;backup_days:number};
const day=86400000;
function policy(input:unknown):Policy {
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('invalid retention policy');
 const p=input as Policy;
 if(Object.keys(p).sort().join(',')!=='backup_days,format,log_days'||p.format!==1||![p.log_days,p.backup_days].every(n=>Number.isInteger(n)&&n>=1&&n<=3650))throw Error('invalid retention policy');
 return p;
}
async function plain(path:string,directory=false){
 const s=await lstat(path);
 if(s.isSymbolicLink()||(directory?!s.isDirectory():!s.isFile())||await realpath(path)!==resolve(path))throw Error('retention requires plain private paths');
 return s;
}
async function hash(path:string){const h=createHash('sha256');for await(const c of createReadStream(path))h.update(c);return h.digest('hex');}

// Only an explicitly provisioned, dedicated private root is admitted. No global
// temp scan, Docker log deletion, database deletion or recursive removal.
export async function retainArtifacts(directory:string,apply=false,now=Date.now()){
 if(!Number.isFinite(now))throw Error('invalid retention clock');
 const root=resolve(directory);await plain(root,true);
 const policyPath=join(root,'retention-policy.json');await plain(policyPath);
 const p=policy(JSON.parse(await readFile(policyPath,'utf8')));
 const lock=await open(join(root,'.retention-lock'),'wx',0o600);
 try{
  const logs=join(root,'logs'),backups=join(root,'backups');await plain(logs,true);await plain(backups,true);
  const removeLogs:string[]=[],removeBackups:string[]=[],held:string[]=[];
  for(const name of await readdir(logs)){
   if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\.log$/.test(name)){held.push('logs/'+name);continue;}
   const s=await plain(join(logs,name));if(s.mtimeMs<now-p.log_days*day)removeLogs.push(name);
  }
  const snapshots:{name:string;created:number;verified:boolean;files:string[]}[]=[];
  for(const name of await readdir(backups)){
   if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(name)){held.push('backups/'+name);continue;}
   const dir=join(backups,name);await plain(dir,true);
   const files=await readdir(dir);
   if(files.some(f=>!['database.dump','manifest.json','restore-verified.json'].includes(f))||!files.includes('database.dump')||!files.includes('manifest.json')){held.push('backups/'+name);continue;}
   for(const f of files)await plain(join(dir,f));
   try{
    const m=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
    const created=Date.parse(m.created_at);
    if(m.format!==1||!Number.isFinite(created)||created>now||m.archive_sha256!==await hash(join(dir,'database.dump')))throw Error('invalid backup');
    let verified=false;
    if(files.includes('restore-verified.json')){const v=JSON.parse(await readFile(join(dir,'restore-verified.json'),'utf8'));verified=v.format===1&&v.archive_sha256===m.archive_sha256&&Number.isFinite(Date.parse(v.verified_at));}
    snapshots.push({name,created,verified,files});
   }catch{held.push('backups/'+name);}
  }
  snapshots.sort((a,b)=>b.created-a.created||a.name.localeCompare(b.name));
  const newest=snapshots[0],verified=snapshots.find(s=>s.verified);
  // No verified recovery point means no automatic backup deletion.
  for(const s of snapshots)if(verified&&s!==newest&&s!==verified&&s.created<now-p.backup_days*day)removeBackups.push(s.name);
  if(apply){
   for(const name of removeLogs){await plain(join(logs,name));await unlink(join(logs,name));}
   for(const name of removeBackups){const s=snapshots.find(s=>s.name===name)!;const dir=join(backups,name);await plain(dir,true);for(const f of s.files){await plain(join(dir,f));await unlink(join(dir,f));}await rmdir(dir);}
  }
  return {applied:apply,policy:p,logs:removeLogs,backups:removeBackups,preserved_latest:newest?.name??null,preserved_verified:verified?.name??null,held};
 }finally{await lock.close();await unlink(join(root,'.retention-lock'));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const [root,mode]=process.argv.slice(2);if(!root||!['--plan','--apply'].includes(mode))throw Error('usage');process.stdout.write(JSON.stringify(await retainArtifacts(root,mode==='--apply'))+'\n');}
 catch{process.stderr.write('Retention failed: check dedicated private root, policy, lock and plain paths. No recursive deletion performed.\n');process.exitCode=1;}
}
