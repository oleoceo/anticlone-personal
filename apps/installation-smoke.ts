// Explicitly invoked by operator against their approved endpoint. No arbitrary backend fetch.
const input = process.argv[2];
const url = new URL(input);
if (url.protocol !== 'https:' || url.origin !== input || url.username || url.password) throw Error('canonical HTTPS gateway origin required');
async function check(path: string, expected: number) {
  const response = await fetch(input + path, {redirect:'error', signal:AbortSignal.timeout(6000)});
  if (response.status !== expected) throw Error('smoke failed: ' + path + ' status ' + response.status);
  return response;
}
const health = await (await check('/healthz', 200)).json() as {mode?:string; action?:string};
if (health.mode !== 'PILOT_OBSERVE' || health.action !== 'OBSERVE_ONLY') throw Error('unexpected gateway mode');
for (const path of ['/runtime.js','/core.js','/fallback.js']) {
  const response = await check(path, 200);
  if (!response.headers.get('content-type')?.startsWith('application/javascript') || !(await response.text()).length) throw Error('script unavailable');
}
await check('/admin',404);
await check('/login',404);
process.stdout.write('Transport ready; scripts available; admin routes closed. Browser installation NOT_VERIFIED.\n');
