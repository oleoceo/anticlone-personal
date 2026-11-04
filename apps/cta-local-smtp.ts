import nodemailer from 'nodemailer';
import { createConnection } from 'node:net';

// This transport has no configurable destination, credentials, proxy or relay.
export async function sendLocalCtaAlert(alertId: string, port: number): Promise<void> {
  if (!/^[1-9][0-9]*$/.test(alertId) || !Number.isInteger(port) || port < 1 || port > 65535) throw Error('invalid laboratory configuration');
  const socket = createConnection({host:'127.0.0.1', port});
  const transport = nodemailer.createTransport({
    host:'127.0.0.1', port, ignoreTLS:true,
    getSocket(_options, callback) { callback(null, {connection:socket}); }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { socket.destroy(); reject(Error('local SMTP deadline')); }, 10_000);
    });
    const result = await Promise.race([transport.sendMail({
      from:'anticlone@example.test', to:'owner@example.test', subject:'CTA requires review',
      text:`CTA alert ${alertId} requires review.`, messageId:`<cta-alert-${alertId}@example.test>`
    }), deadline]);
    if (result.accepted.length !== 1 || result.accepted[0] !== 'owner@example.test') throw Error('local SMTP rejected recipient');
  } finally { if (timer) clearTimeout(timer); socket.destroy(); transport.close(); }
}
