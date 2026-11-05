import { readFileSync, writeFileSync } from 'node:fs';
import { gatewayBoundary } from './gateway-boundary.js';

// Offline render only. Never obtains certificates, starts services, or contacts DNS.
gatewayBoundary({...process.env, GATEWAY_MODE:'PILOT_OBSERVE', GATEWAY_TRANSPORT:'HTTPS_PROXY'});
const output = process.argv[2];
if (!output) throw Error('provide output path outside repository');
writeFileSync(output, readFileSync('infra/https/nginx.conf', 'utf8').replaceAll('PUBLIC_GATEWAY_HOST', process.env.PUBLIC_GATEWAY_HOST!), {mode:0o600, flag:'wx'});
