import { spawnSync } from 'node:child_process';
import { localConfig, secretNames, apiClient, config } from './config.mjs';
const {base, vars} = localConfig();
if (!base.startsWith('https://')) throw new Error('Secret upload requires the hosted HTTPS service.');
const api = apiClient(base, vars.OWNER_API_KEY);
let state;
try { state = await api('/v1/admin/status'); }
catch (e) { if (!process.argv.includes('--bootstrap')) throw e; }
if (state && (!state.draining || state.activeCalls.length || state.finalizingCalls?.length)) throw new Error('Pause admission and wait for all calls to finish before rotating secrets.');
if (!state && (config().vars.LIVE_ENABLED !== 'false' || config().vars.CONTROLLED_TEST_NUMBER)) throw new Error('Bootstrap upload requires a new simulation-only service.');
const values = Object.fromEntries(secretNames.filter(k => vars[k]).map(k => [k, vars[k]]));
if (!values.OWNER_API_KEY || !values.MEDIA_SIGNING_KEY) throw new Error('Run npm run setup first.');
const r = spawnSync('npx',['wrangler','secret','bulk'], {input:JSON.stringify(values), stdio:['pipe','inherit','inherit'],timeout:120000});
if (r.status !== 0) throw new Error('Secret upload failed.');
console.log('Uploaded named secrets through stdin. Local-only live flags were excluded.');
