import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';

// Exact code before PR #44, compiled without using any current application source.
export const previousCodeSha='73bee1c25507ca617df09e243a08b80ab99484d7';
export async function compilePreviousCode() {
  const directory=await mkdtemp(join(tmpdir(),'anticlone-rollback-'));
  try {
    const files=execFileSync('git',['ls-tree','-r','--name-only',previousCodeSha],{encoding:'utf8'}).trim().split('\n')
      .filter(file=>file.startsWith('apps/') || file.startsWith('runtime/') || ['package.json','tsconfig.json'].includes(file));
    for (const file of files) {
      const target=join(directory,file); await mkdir(dirname(target),{recursive:true});
      await writeFile(target,execFileSync('git',['show',`${previousCodeSha}:${file}`]));
    }
    await symlink(resolve('node_modules'),join(directory,'node_modules'),process.platform==='win32'?'junction':'dir');
    execFileSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'--project',join(directory,'tsconfig.json')],{stdio:'pipe'});
    return directory;
  } catch(error) { await rm(directory,{recursive:true,force:true}); throw error; }
}
