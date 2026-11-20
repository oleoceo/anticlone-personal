import {readFileSync} from 'node:fs';
import {createServer, type ServerOptions} from 'node:https';
import type {RequestListener} from 'node:http';
import type {TLSSocket} from 'node:tls';
import {isIPv4} from 'node:net';

export function npmListenAddress(env:NodeJS.ProcessEnv) {
  const address=env.NPM_LISTEN_ADDRESS;
  const peer=env.NPM_PROXY_PEER_ADDRESS;
  // Existing Compose isolates its wildcard listener inside the container.
  if (address === undefined && peer === undefined) return '0.0.0.0';
  const privateIpv4=(value:string|undefined) => value && isIPv4(value) &&
    /^(127\.0\.0\.1$|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(value);
  if (!address || !privateIpv4(address) || !privateIpv4(peer) ||
      (address === '127.0.0.1') !== (peer === '127.0.0.1') ||
      (address !== '127.0.0.1' && peer === address)) throw Error('invalid NPM private listener');
  return address;
}

export function npmFingerprints(env:NodeJS.ProcessEnv) {
  const proxy=env.NPM_PROXY_FINGERPRINT, monitor=env.NPM_MONITOR_FINGERPRINT;
  if(!proxy || !monitor || !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(proxy) || !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(monitor) || proxy===monitor) throw Error('invalid NPM certificate pins');
  return {proxy,monitor};
}
export function npmPeer(socket:TLSSocket,env:NodeJS.ProcessEnv):'proxy'|'monitor'|undefined {
  const pins=npmFingerprints(env);
  if(!socket.encrypted || !socket.authorized) return;
  const fingerprint=socket.getPeerCertificate().fingerprint256;
  return fingerprint===pins.proxy?'proxy':fingerprint===pins.monitor?'monitor':undefined;
}
export function npmTls(env:NodeJS.ProcessEnv):ServerOptions {
  npmFingerprints(env);
  const load=(key:string)=>{if(!env[key])throw Error('missing NPM TLS file');return readFileSync(env[key]!);};
  return {key:load('NPM_TLS_KEY_FILE'),cert:load('NPM_TLS_CERT_FILE'),ca:load('NPM_CLIENT_CA_FILE'),requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2',handshakeTimeout:5000};
}
export function npmServer(env:NodeJS.ProcessEnv,handler:RequestListener) {
  const address=npmListenAddress(env);
  const server=createServer(npmTls(env),handler);
  if (env.NPM_PROXY_PEER_ADDRESS) {
    server.prependListener('connection',socket=>{
      if (socket.remoteAddress!==env.NPM_PROXY_PEER_ADDRESS && socket.remoteAddress!==address) socket.destroy();
    });
  }
  server.maxConnections=256;
  return server;
}
