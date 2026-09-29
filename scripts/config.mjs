import fs from 'node:fs';
import { readLocalEnv } from './local-env.mjs';
export const secretNames = ['OWNER_API_KEY', 'MEDIA_SIGNING_KEY', 'OPENAI_API_KEY', 'TELNYX_API_KEY', 'TELNYX_PUBLIC_KEY', 'TELNYX_CONNECTION_ID', 'TELNYX_FROM_NUMBER', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUDIENCE', 'CALLBACK_SIGNING_KEY'];
export function config() { return JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8')); }
export function serviceUrl(value, local = false) {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('Use a plain service origin, without a path or credentials.');
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) throw new Error('Use HTTPS (or loopback HTTP for simulation).');
  if (u.hostname.endsWith('example.com')) throw new Error('Replace the example hostname with your own Worker URL.');
  return u.origin;
}
export function localConfig() { return { base: serviceUrl(process.env.CALLING_API_URL || config().vars.PUBLIC_BASE_URL, true), vars: readLocalEnv() }; }
export function apiClient(base, token, transport = fetch) {
  if (!token) throw new Error('Missing API credential.');
  return async (path, body, key) => {
    if (!path.startsWith('/v1/') || path.includes('..') || path.includes('\\')) throw new Error('Use a relative /v1/ path.');
    const response = await transport(base + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(key ? {'idempotency-key': key} : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`Calling API ${response.status}: ${data.error?.code || 'request_failed'}. Re-fetch state before retrying; preserve the original idempotency key.`);
    return data;
  };
}
export function privateWrite(path, text) {
  fs.mkdirSync('.local', {recursive:true, mode:0o700});
  fs.writeFileSync(path, text, {mode:0o600}); fs.chmodSync(path, 0o600);
}
