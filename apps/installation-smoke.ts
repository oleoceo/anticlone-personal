// Explicitly invoked by operator against their approved endpoint. No arbitrary backend fetch.
const input = process.argv[2];
const expectedMode = process.argv[3] ?? 'PILOT_OBSERVE';
const installation = process.argv[4];
if (!['PILOT_OBSERVE','OPERATIONAL'].includes(expectedMode) || process.argv.length > 5) throw Error('explicit PILOT_OBSERVE or OPERATIONAL mode required');
if (expectedMode === 'OPERATIONAL' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(installation??'')) throw Error('OPERATIONAL requires an explicit installation UUID');
if (expectedMode !== 'OPERATIONAL' && installation !== undefined) throw Error('installation UUID requires OPERATIONAL');
const url = new URL(input);
if (url.protocol !== 'https:' || url.origin !== input || url.username || url.password) throw Error('canonical HTTPS gateway origin required');
async function check(path: string, expected: number) {
  const response = await fetch(input + path, {redirect:'error', signal:AbortSignal.timeout(6000)});
  if (response.status !== expected) throw Error('smoke failed: ' + path + ' status ' + response.status);
  return response;
}
const health = await (await check('/healthz', 200)).json() as {mode?:string; action?:string};
if (health.mode !== expectedMode || health.action !== (expectedMode === 'OPERATIONAL' ? 'SCOPED_AUTHORIZATION_REQUIRED' : 'OBSERVE_ONLY')) throw Error('unexpected gateway mode');
for (const resource of ['runtime.js','core.js','fallback.js']) {
  const path = (expectedMode === 'OPERATIONAL' ? `/i/${installation}/` : '/') + resource;
  const response = await check(path, 200);
  if (!response.headers.get('content-type')?.startsWith('application/javascript') || !(await response.text()).length) throw Error('script unavailable');
}
await check('/admin',404);
await check('/login',404);
process.stdout.write(`Transport ready (${expectedMode}); scripts available; admin routes closed. Browser installation NOT_VERIFIED; page authorization is separate.\n`);
