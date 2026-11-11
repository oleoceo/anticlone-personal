import { Pool, type PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type Tool = (name: 'pg_dump' | 'pg_restore', args: string[], env: NodeJS.ProcessEnv, file: string) => Promise<void>;
// Passwords travel only in the child environment. Never echo stderr (it can contain connection details).
export const postgresTool: Tool = async (name, args, env, file) => {
  const child = spawn(name, args, {env, stdio:['ignore','pipe','pipe']});
  const timeout = setTimeout(()=>child.kill('SIGKILL'), 10 * 60_000);
  timeout.unref();
  child.stderr.resume();
  const exited = new Promise<void>((done, reject) => {
    child.once('error', () => reject(Error('PostgreSQL tool unavailable')));
    child.once('exit', code => code === 0 ? done() : reject(Error('PostgreSQL tool failed')));
  });
  // Attach handlers before streaming to prevent an unhandled rejected promise.
  const output = name === 'pg_dump' ? pipeline(child.stdout, createWriteStream(file, {flags:'wx',mode:0o600})) : pipeline(child.stdout, new Writable({write(_chunk,_encoding,done){done();}}));
  try { await Promise.all([exited,output]); } catch (error) { child.kill(); throw error; } finally { clearTimeout(timeout); }
};

function connection(url: string) {
  const parsed = new URL(url);
  if (!['postgres:','postgresql:'].includes(parsed.protocol) || parsed.search || parsed.hash) throw Error('use a plain PostgreSQL URL without options');
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!database || !parsed.hostname || !parsed.username) throw Error('invalid database configuration');
  return {database, env:{...process.env,PGHOST:parsed.hostname,PGPORT:parsed.port || '5432',PGDATABASE:database,PGUSER:decodeURIComponent(parsed.username),PGPASSWORD:decodeURIComponent(parsed.password),PGOPTIONS:'',PGAPPNAME:'anticlone-recovery'}};
}
const quoted = (value: string) => '"' + value.replaceAll('"','""') + '"';
async function digest(file: string) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
// Sorted, streamed rows bound memory to a 500-row cursor page, including duplicate rows.
async function inventory(client: PoolClient) {
  await client.query("SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO, YMD'");
  const tables = await client.query<{schema:string;name:string}>(`SELECT schemaname AS schema,tablename AS name FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY schemaname,tablename`);
  const result: {schema:string;name:string;rows:number;sha256:string}[] = [];
  for (const table of tables.rows) {
    const hash = createHash('sha256'); let rows = 0;
    await client.query(`DECLARE recovery_rows NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS row FROM ${quoted(table.schema)}.${quoted(table.name)} t ORDER BY row_to_json(t)::text COLLATE "C"`);
    for (;;) {
      const batch = await client.query<{row:string}>('FETCH 500 FROM recovery_rows');
      for (const value of batch.rows) { hash.update(value.row); hash.update('\n'); rows++; }
      if (!batch.rowCount) break;
    }
    await client.query('CLOSE recovery_rows');
    result.push({...table,rows,sha256:hash.digest('hex')});
  }
  return result;
}
type Manifest = {format:1;created_at:string;source_database:string;archive_sha256:string;tables:Awaited<ReturnType<typeof inventory>>};

export async function backup(databaseUrl: string, directory: string, tool: Tool = postgresTool) {
  const config = connection(databaseUrl), folder = resolve(directory);
  // Exclusive creation prevents replacing an existing recovery point.
  await mkdir(folder,{mode:0o700});
  const pool = new Pool({connectionString:databaseUrl,max:1}), client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id as string;
    const tables = await inventory(client);
    await tool('pg_dump',['--format=custom','--no-owner','--no-privileges',`--snapshot=${snapshot}`],config.env,resolve(folder,'database.dump'));
    const manifest: Manifest = {format:1,created_at:new Date().toISOString(),source_database:config.database,archive_sha256:await digest(resolve(folder,'database.dump')),tables};
    await client.query('COMMIT');
    // Written last: an interrupted dump has no valid manifest and cannot be restored.
    await writeFile(resolve(folder,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
    return manifest;
  } finally { client.release(); await pool.end(); }
}

export async function restore(databaseUrl: string, directory: string, confirmation: string, tool: Tool = postgresTool) {
  const config = connection(databaseUrl), folder = resolve(directory);
  if (!/^anticlone_restore_[a-z0-9_]{1,40}$/.test(config.database) || confirmation !== config.database) throw Error('restore requires an explicitly confirmed isolated database');
  const manifest = JSON.parse(await readFile(resolve(folder,'manifest.json'),'utf8')) as Manifest;
  if (manifest.format !== 1 || !Array.isArray(manifest.tables) || !manifest.tables.length || config.database === manifest.source_database) throw Error('invalid recovery manifest or source database');
  const archive = resolve(folder,'database.dump');
  if (!(await stat(archive)).isFile() || await digest(archive) !== manifest.archive_sha256) throw Error('backup integrity check failed');
  const pool = new Pool({connectionString:databaseUrl,max:1}), client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(74621391)');
    const occupied = await client.query(`
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      UNION ALL SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public','pg_catalog','information_schema') AND nspname NOT LIKE 'pg_%'
      UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema')
      UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      UNION ALL SELECT 1 FROM pg_extension WHERE extname<>'plpgsql'
      UNION ALL SELECT 1 FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema')
      UNION ALL SELECT 1 FROM pg_event_trigger
      UNION ALL SELECT 1 FROM pg_foreign_server
      UNION ALL SELECT 1 FROM pg_largeobject_metadata
      UNION ALL SELECT 1 FROM pg_publication
      UNION ALL SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`);
    if (occupied.rowCount) throw Error('restore database must be empty and offline');
    await tool('pg_restore',['--single-transaction','--exit-on-error','--no-owner','--no-privileges','--dbname='+config.database,archive],config.env,archive);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const actual = await inventory(client);
    await client.query('COMMIT');
    if (JSON.stringify(actual) !== JSON.stringify(manifest.tables)) throw Error('restored data integrity mismatch; keep database isolated');
    // An immutable receipt allows retention to preserve a recovery point that
    // was actually restored. Never replace an existing file or follow a link.
    const receipt=resolve(folder,'restore-verified.json');
    const proof=JSON.stringify({format:1,archive_sha256:manifest.archive_sha256,verified_at:new Date().toISOString()})+'\n';
    try { await writeFile(receipt,proof,{flag:'wx',mode:0o600}); }
    catch(error) { if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error; }
    return {verified:true,tables:actual.length};
  } finally { await client.query('SELECT pg_advisory_unlock(74621391)').catch(()=>{}); client.release(); await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command,directory,confirmation] = process.argv.slice(2), url = process.env.RECOVERY_DATABASE_URL;
    if (!url || !directory || !['backup','restore'].includes(command)) throw Error('usage: recovery backup|restore DIRECTORY [isolated_database_name]; set RECOVERY_DATABASE_URL privately');
    const result = command === 'backup' ? await backup(url,directory) : await restore(url,directory,confirmation);
    process.stdout.write(JSON.stringify(command === 'backup' ? {backup:true,tables:(result as Manifest).tables.length} : result)+'\n');
  } catch { process.stderr.write('Recovery failed: verify private configuration, PostgreSQL tools, manifest and empty isolated target. No credentials logged.\n'); process.exitCode=1; }
}
