import nodemailer from 'nodemailer';
import type { PoolClient } from 'pg';
import { createConnection, type Socket } from 'node:net';

export type SmtpProvider = Readonly<{provider:'smtp'|'brevo'; host:string; port:number; tls_mode:'implicit'|'starttls'; sender:string; recipient:string; user:string; password:string}>;
// Credentials and network destination come only from the private process environment.
export function smtpProvider(env: NodeJS.ProcessEnv): SmtpProvider | undefined {
  if (!env.SMTP_PROVIDER) return undefined;
  const provider=env.SMTP_PROVIDER, host=env.SMTP_HOST ?? '', port=Number(env.SMTP_PORT), tls_mode=env.SMTP_TLS;
  const sender=env.SMTP_SENDER ?? '', recipient=env.SMTP_RECIPIENT ?? '', user=env.SMTP_USER ?? '', password=env.SMTP_PASSWORD ?? '';
  const mailbox=/^[a-zA-Z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+\/=?^_`{|}~-]+)*@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,63}$/;
  if (!['smtp','brevo'].includes(provider) || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host)
    || !Number.isInteger(port) || port<1 || port>65535 || !['implicit','starttls'].includes(tls_mode ?? '')
    || !mailbox.test(sender) || !mailbox.test(recipient) || sender.length>254 || recipient.length>254
    || !user || !password || user.length>512 || password.length>2048 || /[\r\n\0]/.test(user+password)) throw Error('invalid private SMTP configuration');
  return Object.freeze({provider:provider as SmtpProvider['provider'],host,port,tls_mode:tls_mode as SmtpProvider['tls_mode'],sender,recipient,user,password});
}

export async function providerAuthorized(db: Pick<PoolClient,'query'>, config:SmtpProvider): Promise<boolean> {
  const result=await db.query('SELECT provider,host,port,tls_mode,sender,recipient,requested FROM notification_settings WHERE singleton=true');
  const row=result.rows[0];
  return !!row?.requested && (['provider','host','port','tls_mode','sender','recipient'] as const).every(key=>row[key]===config[key]);
}

export async function sendProviderAlert(config:SmtpProvider, id:string, host:string): Promise<void> {
  let socket:Socket|undefined;
  const transport=nodemailer.createTransport({host:config.host,port:config.port,secure:config.tls_mode==='implicit',requireTLS:true,
    auth:{user:config.user,pass:config.password},tls:{minVersion:'TLSv1.2',rejectUnauthorized:true},
    connectionTimeout:3000,greetingTimeout:3000,socketTimeout:3000,disableFileAccess:true,disableUrlAccess:true,
    getSocket(_options,callback){
      socket=createConnection({host:config.host,port:config.port});
      const failed=(error:Error)=>callback(error,{});
      socket.once('error',failed);
      socket.once('connect',()=>{socket!.removeListener('error',failed);callback(null,{connection:socket});});
    }});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{socket?.destroy();reject(Error('SMTP total deadline'));},10000);});
    const result=await Promise.race([transport.sendMail({from:config.sender,to:config.recipient,subject:'AntiClone: unverified clone signal',
      text:`Project observation requires review. Unverified browser claim for host: ${host}`,
      messageId:`<anticlone-${id}@${config.sender.split('@')[1]}>`}),deadline]);
    if (result.accepted.length!==1 || String(result.accepted[0]).toLowerCase()!==config.recipient.toLowerCase() || result.rejected.length) throw Error('SMTP recipient not accepted');
  } finally {if(timer)clearTimeout(timer);socket?.destroy();transport.close();}
}
