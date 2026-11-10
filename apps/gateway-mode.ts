import { isIP } from 'node:net';
import { configuredOrigin } from './detection.js';

// Operator configuration, never inferred from a browser claim or forwarding header.
export function gatewayMode(env: NodeJS.ProcessEnv, primary: string): {pilot: boolean; origins: readonly string[]} {
  const mode = env.GATEWAY_MODE ?? 'LAB';
  if (mode !== 'LAB' && mode !== 'PILOT_OBSERVE' && mode !== 'OPERATIONAL') throw Error('invalid gateway mode');
  if (mode === 'OPERATIONAL') {
    if (Object.keys(env).some(key=>/^(SCOPED_LAB_|LAB_CONTROLLED_)/.test(key)&&env[key]) || env.ALLOWED_ORIGIN) throw Error('laboratory configuration forbidden operationally');
    return {pilot:true,origins:[primary]};
  }
  if (mode === 'LAB') {
    if (env.PILOT_ORIGINS) throw Error('pilot origins require pilot mode');
    return {pilot:false, origins:[primary]};
  }
  if (env.LAB_CONTROLLED_ORIGIN || env.LAB_CONTROLLED_RISK || env.ALLOWED_ORIGIN) throw Error('laboratory configuration forbidden in pilot');
  const values: unknown = JSON.parse(env.PILOT_ORIGINS ?? 'null');
  if (!Array.isArray(values) || values.length < 1 || values.length > 20) throw Error('invalid pilot origins');
  const origins = values.map((value: unknown) => {
    if (typeof value !== 'string' || /[\s\\]/.test(value)) throw Error('invalid pilot origin');
    const origin = configuredOrigin(value), url = new URL(origin);
    if (value !== origin || url.protocol !== 'https:' || url.port || isIP(url.hostname) || !url.hostname.includes('.') || url.hostname.endsWith('.') || !url.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')) throw Error('invalid pilot origin');
    return origin;
  });
  if (new Set(origins).size !== origins.length || !origins.includes(primary)) throw Error('pilot origins must include primary exactly once');
  return {pilot:true, origins:Object.freeze(origins)};
}
