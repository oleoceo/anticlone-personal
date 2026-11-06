import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OperationalObservations } from '../apps/operational-observations.js';
import { OptionalSchema } from '../apps/optional-schema.js';

test('optional schema reports only real executions and recovers after backoff',async()=>{
  let now=0; const events:string[]=[];
  const gate=new OptionalSchema('installation',true,()=>{},()=>now,(source,failed)=>events.push(`${source}:${failed}`));
  await gate.run('claim',async()=>{throw {code:'42P01'};});
  await gate.run('claim',async()=>{});
  assert.deepEqual(events,['installation_claim:true']);
  now=60000; await gate.run('claim',async()=>{});
  assert.deepEqual(events,['installation_claim:true','installation_claim:false']);
  const missing=new OptionalSchema('missing',false,()=>{},()=>now,(source,failed)=>events.push(`${source}:${failed}`));
  await missing.run('claim',async()=>{});
  assert.equal(events.length,2);
});

test('concurrent recovery remains queued across persistence failure and retry',async()=>{
  const monitor=new OperationalObservations(); monitor.observe('installation',true);
  let unblock!:()=>void, entered!:()=>void;
  const barrier=new Promise<void>(resolve=>{unblock=resolve;});
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const writes: {key?:string;recoveredAt?:Date}[]=[];
  const first=monitor.reconcile(async entry=>{writes.push({...entry});entered();await barrier;});
  await started; monitor.observe('installation',false); unblock(); await first;
  await assert.rejects(monitor.reconcile(async entry=>{writes.push({...entry});throw Error('write failed');}));
  await monitor.reconcile(async entry=>{writes.push({...entry});});
  await monitor.reconcile(async()=>{throw Error('entry was not removed');});
  assert.equal(writes.length,3); assert.ok(writes[0].key); assert.equal(writes[0].recoveredAt,undefined);
  assert.ok(writes[1].recoveredAt); assert.equal(writes[1].key,writes[2].key); assert.equal(writes[1].recoveredAt,writes[2].recoveredAt);
});
