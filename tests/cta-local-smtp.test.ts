import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { sendLocalCtaAlert } from '../apps/cta-local-smtp.js';
import { spawnSync } from 'node:child_process';

test('worker is disabled without explicit laboratory activation', () => {
  const env={...process.env,CTA_SMTP_LAB:'',CTA_SMTP_LAB_PORT:'2525'};
  const worker=spawnSync(process.execPath,['dist/apps/cta-delivery-worker.js'],{env,encoding:'utf8'});
  assert.notEqual(worker.status,0);
  assert.match(worker.stderr,/laboratory explicitly disabled/);
});

test('local SMTP accepts only synthetic addresses and uses a stable Message-ID', async () => {
  const messages: string[] = [];
  const smtp = new SMTPServer({authOptional:true, disabledCommands:['AUTH','STARTTLS'],
    onMailFrom(address, _session, cb) { assert.equal(address.address, 'anticlone@example.test'); cb(); },
    onRcptTo(address, _session, cb) { assert.equal(address.address, 'owner@example.test'); cb(); },
    onData(stream, _session, cb) { let message=''; stream.on('data', chunk=>{message+=String(chunk);}); stream.on('end',()=>{messages.push(message); cb();}); }
  });
  await new Promise<void>(resolve=>smtp.listen(0,'127.0.0.1',resolve));
  const addr=smtp.server.address(); assert.ok(addr && typeof addr !== 'string');
  try {
    await sendLocalCtaAlert('123',addr.port); await sendLocalCtaAlert('123',addr.port);
    assert.equal(messages.length,2);
    for (const message of messages) assert.match(message,/Message-ID: <cta-alert-123@example\.test>/i);
    await assert.rejects(sendLocalCtaAlert('bad\r\nBcc: x',addr.port));
  } finally { await new Promise<void>(resolve=>smtp.close(()=>resolve())); }
});

test('local SMTP recipient rejection is a failure', async () => {
  const smtp=new SMTPServer({authOptional:true,disabledCommands:['AUTH','STARTTLS'],onRcptTo(_address,_session,cb){cb(new Error('rejected'));}});
  await new Promise<void>(resolve=>smtp.listen(0,'127.0.0.1',resolve));
  const addr=smtp.server.address(); assert.ok(addr && typeof addr !== 'string');
  try { await assert.rejects(sendLocalCtaAlert('1',addr.port)); }
  finally { await new Promise<void>(resolve=>smtp.close(()=>resolve())); }
});

test('local SMTP enforces a total deadline and closes a stalled socket', {timeout:15000}, async () => {
  let closed=false; let peer: Socket | undefined;
  const server=createServer(socket=>{peer=socket; socket.on('close',()=>{closed=true;});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const addr=server.address(); assert.ok(addr && typeof addr !== 'string');
  try {
    await assert.rejects(sendLocalCtaAlert('1',addr.port));
    await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(closed,true);
  } finally { peer?.destroy(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
