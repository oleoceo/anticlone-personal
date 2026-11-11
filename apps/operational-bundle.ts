import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {configuredOrigin} from './detection.js';

// Explicit operational settings only; credentials are deliberately supplied
// independently during recovery. Never serialize process.env or arbitrary files.
const allowed=['GATEWAY_MODE','PUBLIC_GATEWAY_HOST','RUNTIME_PUBLIC_ORIGIN','SMTP_PROVIDER','SMTP_HOST','SMTP_PORT','SMTP_TLS'];
function validate(input:unknown):Record<string,string>{
 if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('invalid configuration');
 const value=input as Record<string,unknown>;
 if(Object.keys(value).some(k=>!allowed.includes(k))||Object.values(value).some(v=>typeof v!=='string'||v.length>2048||/[\r\n\0]/.test(v)))throw new TypeError('configuration contains unsupported keys');
 for(const [key,raw] of Object.entries(value)){
  const text=raw as string;
  if(key==='GATEWAY_MODE'&&!['LAB','PILOT_OBSERVE','OPERATIONAL'].includes(text)||key==='SMTP_PROVIDER'&&!['smtp','brevo'].includes(text)||key==='SMTP_TLS'&&!['implicit','starttls'].includes(text)||key==='SMTP_PORT'&&(!/^\d{1,5}$/.test(text)||Number(text)<1||Number(text)>65535)||(key==='SMTP_HOST'||key==='PUBLIC_GATEWAY_HOST')&&!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(text))throw new TypeError('invalid operational setting');
  if(key==='RUNTIME_PUBLIC_ORIGIN'&&(configuredOrigin(text)!==text||!text.startsWith('https://')))throw new TypeError('invalid runtime origin');
 }
 return value as Record<string,string>;
}
export async function saveOperationalBundle(directory:string,configuration:unknown,codeSha:string){
 const values=validate(configuration);if(!/^[a-f0-9]{40}$/.test(codeSha))throw new TypeError('invalid code SHA');
 const content=JSON.stringify(values,null,2)+'\n';await mkdir(directory,{mode:0o700});
 await writeFile(join(directory,'operational.json'),content,{flag:'wx',mode:0o600});
 const manifest={format:1,code_sha:codeSha,created_at:new Date().toISOString(),sha256:createHash('sha256').update(content).digest('hex'),credentials_included:false};
 await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});return manifest;
}
export async function readOperationalBundle(directory:string){
 const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
 const content=await readFile(join(directory,'operational.json'),'utf8');
 if(manifest.format!==1||manifest.credentials_included!==false||!/^[a-f0-9]{40}$/.test(manifest.code_sha)||createHash('sha256').update(content).digest('hex')!==manifest.sha256)throw Error('invalid operational bundle');
 return {configuration:validate(JSON.parse(content)),codeSha:manifest.code_sha as string,credentialsRequired:true};
}
