import {execFileSync} from 'node:child_process';
import {join} from 'node:path';

export async function syntheticTls(dir:string){
  for(const name of ['server','proxy','monitor','stranger'])execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,name+'.key'),'-out',join(dir,name+'.crt'),'-days','1','-subj','/CN='+name,'-addext','subjectAltName=DNS:gateway.test'],{stdio:'ignore'});
  const pin=(name:string)=>execFileSync('openssl',['x509','-in',join(dir,name+'.crt'),'-noout','-fingerprint','-sha256'],{encoding:'utf8'}).trim().split('=')[1];
  return {GATEWAY_TRANSPORT:'NPM_MTLS',GATEWAY_MODE:'OPERATIONAL',PUBLIC_GATEWAY_HOST:'gateway.test',NPM_PROXY_FINGERPRINT:pin('proxy'),NPM_MONITOR_FINGERPRINT:pin('monitor'),NPM_TLS_KEY_FILE:join(dir,'server.key'),NPM_TLS_CERT_FILE:join(dir,'server.crt'),NPM_CLIENT_CA_FILE:join(dir,'proxy.crt')};
}
