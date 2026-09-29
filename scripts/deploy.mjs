import { spawnSync } from 'node:child_process';
import { config, localConfig, apiClient } from './config.mjs';
const c = config(), {base, vars} = localConfig();
if (!base.startsWith('https://')) throw new Error('Deployment requires your own HTTPS Worker URL.');
const bootstrap = process.argv.includes('--bootstrap'), api = apiClient(base, vars.OWNER_API_KEY);
const health = await fetch(base+'/health', {signal:AbortSignal.timeout(5000)}).catch(() => null);
const existing = health?.ok && Boolean((await health.json().catch(()=>({}))).version);
if (!existing && !bootstrap) throw new Error('Cannot confirm remote state; refusing deployment. For a genuinely NEW, simulation-only Worker use npm run deploy -- --bootstrap.');
if (bootstrap && (c.vars.LIVE_ENABLED !== 'false' || c.vars.ROLLOUT_VERIFIED !== 'false' || c.vars.CONTROLLED_TEST_NUMBER || Number(c.vars.CONTROLLED_TEST_UNTIL))) throw new Error('Bootstrap requires live calling and the controlled-test exception disabled.');
let wasDraining = true, drainChanged = false;
try {
  if (existing) {
    wasDraining = (await api('/v1/admin/status')).draining;
    await api('/v1/admin/control', {draining:true}, crypto.randomUUID()); drainChanged = true;
    const state = await api('/v1/admin/status');
    if (state.activeCalls.length || state.finalizingCalls?.length) throw new Error('Active or unresolved calls remain. Wait for finalization/reconciliation before deployment.');
  }
  for (const args of [['run','check'],['test'],['run','build']]) {
    if (spawnSync('npm',args,{stdio:'inherit',timeout:300000}).status !== 0) throw new Error('Predeployment checks failed.');
  }
  if (spawnSync('npx',['wrangler','deploy'],{stdio:'inherit',timeout:180000}).status !== 0) throw new Error('Deployment failed.');
} finally {
  if (drainChanged && !wasDraining) await api('/v1/admin/control',{draining:false},crypto.randomUUID());
}
