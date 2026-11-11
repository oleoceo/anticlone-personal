import {readFile,stat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {ingestActivity,type ActivitySource} from './authorized-activity.js';

// Offline trusted-machine import; no public endpoint, account connection or URL fetch.
export async function importActivityFile(db:Pool,eventFile:string,configFile:string) {
  if((await stat(eventFile)).size>4096||(await stat(configFile)).size>65536)throw new TypeError('import file too large');
  const envelope=JSON.parse(await readFile(eventFile,'utf8'));
  const sources:ActivitySource[]=JSON.parse(await readFile(configFile,'utf8'));
  if(!envelope||Object.keys(envelope).sort().join(',')!=='event,signature'||!Array.isArray(sources))throw new TypeError('invalid import files');
  const configured=sources.filter(s=>s.id===envelope.event?.source&&s.project===envelope.event?.project&&s.page===envelope.event?.page);
  if(configured.length!==1)throw new TypeError('source not uniquely authorized');
  return ingestActivity(db,envelope.event,envelope.signature,configured[0]);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const db=new Pool({connectionString:process.env.DATABASE_URL});
  try {
    if(!process.env.DATABASE_URL||!process.env.ACTIVITY_SOURCES_FILE||process.argv.length!==3)throw Error('configuration required');
    process.stdout.write(JSON.stringify(await importActivityFile(db,process.argv[2],process.env.ACTIVITY_SOURCES_FILE))+'\n');
  }catch{process.stderr.write('Authorized activity import failed; check local source configuration and signed evidence\n');process.exitCode=1;}
  finally{await db.end();}
}
