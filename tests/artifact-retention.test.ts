import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,utimes,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {retainArtifacts} from '../apps/artifact-retention.js';

test('F37: real files, dry-run, expiry, verified/newest recovery points, invalid archives and path boundaries',async()=>{
 const root=await mkdtemp(join(tmpdir(),'anticlone-retention-')),now=Date.now(),day=86400000;
 try{
  await mkdir(join(root,'logs'));await mkdir(join(root,'backups'));
  const config=join(root,'retention-policy.json');await writeFile(config,JSON.stringify({format:1,log_days:7,backup_days:30}));
  await writeFile(join(root,'logs','old.log'),'synthetic');await utimes(join(root,'logs','old.log'),new Date(now-8*day),new Date(now-8*day));
  await writeFile(join(root,'logs','fresh.log'),'synthetic');
  const sha=createHash('sha256').update('synthetic dump').digest('hex');
  async function snapshot(name:string,age:number,verified=false){const dir=join(root,'backups',name);await mkdir(dir);await writeFile(join(dir,'database.dump'),'synthetic dump');await writeFile(join(dir,'manifest.json'),JSON.stringify({format:1,created_at:new Date(now-age*day).toISOString(),archive_sha256:sha}));if(verified)await writeFile(join(dir,'restore-verified.json'),JSON.stringify({format:1,archive_sha256:sha,verified_at:new Date(now).toISOString()}));}
  await snapshot('expired',80);await snapshot('verified',60);await snapshot('latest',40);
  assert.deepEqual((await retainArtifacts(root,false,now)).backups,[],'unverified backups never pruned');
  await writeFile(join(root,'backups','verified','restore-verified.json'),JSON.stringify({format:1,archive_sha256:sha,verified_at:new Date(now).toISOString()}));
  await snapshot('corrupt',90,true);await writeFile(join(root,'backups','corrupt','database.dump'),'corrupt');
  const plan=await retainArtifacts(root,false,now);assert.deepEqual(plan.backups,['expired']);assert.deepEqual(plan.logs,['old.log']);assert.equal(plan.preserved_verified,'verified');assert.ok(plan.held.includes('backups/corrupt'));
  assert.equal(await readFile(join(root,'logs','old.log'),'utf8'),'synthetic');
  const applied=await retainArtifacts(root,true,now);assert.deepEqual(applied.backups,plan.backups);assert.deepEqual((await readdir(join(root,'backups'))).sort(),['corrupt','latest','verified']);assert.deepEqual(await readdir(join(root,'logs')),['fresh.log']);
  assert.deepEqual((await retainArtifacts(root,true,now)).backups,[]);
  await symlink(join(root,'logs'),join(root,'backups','linked'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(retainArtifacts(root,true,now),/plain private paths/);assert.equal(await readFile(join(root,'logs','fresh.log'),'utf8'),'synthetic');
  await writeFile(config,JSON.stringify({format:1,log_days:0,backup_days:30}));await assert.rejects(retainArtifacts(root),/policy/);
 }finally{await rm(root,{recursive:true,force:true});}
});
