import { localConfig, apiClient, config } from './config.mjs';
const {base, vars} = localConfig(); let problems = 0;
function report(name, ok) { console.log(`${ok?'PASS':'CHECK'} ${name}`); if (!ok) problems++; }
for (const name of ['OWNER_API_KEY','MEDIA_SIGNING_KEY','OPENAI_API_KEY','TELNYX_API_KEY','TELNYX_PUBLIC_KEY','TELNYX_CONNECTION_ID','TELNYX_FROM_NUMBER']) report(`${name} configured`, Boolean(vars[name]));
try { const r = await apiClient(base,vars.OWNER_API_KEY)('/v1/me'); report('Service owner authentication',r.principal.owner); console.log(`Live readiness: ${r.liveReady ? 'enabled' : 'disabled (expected during setup)'}`); }
catch { report('Service owner authentication',false); }
async function get(url,key) { const r = await fetch(url,{headers:{authorization:`Bearer ${key}`},redirect:'error',signal:AbortSignal.timeout(10000)}); if (!r.ok) throw new Error('Provider check failed'); return r.json(); }
if (vars.OPENAI_API_KEY) try {
  const models = await get('https://api.openai.com/v1/models',vars.OPENAI_API_KEY);
  for (const k of ['OPENAI_LIVE_MODEL','REASONING_MODEL','SUMMARY_MODEL','DEEP_MODEL']) report(`${k} visible in account model list`,models.data.some(m=>m.id===config().vars[k]));
} catch { report('OpenAI read-only access',false); }
if (vars.TELNYX_API_KEY && vars.TELNYX_CONNECTION_ID) try {
  const {data} = await get('https://api.telnyx.com/v2/call_control_applications/'+encodeURIComponent(vars.TELNYX_CONNECTION_ID),vars.TELNYX_API_KEY);
  report('Telnyx Voice API application exists',Boolean(data.id));
  report('Application webhook matches this service',data.webhook_event_url===base+'/webhooks/telnyx');
  report('Outbound profile assigned',Boolean(data.outbound?.outbound_voice_profile_id));
} catch { report('Telnyx application access',false); }
console.log('Read-only checks do not prove model-session access, dialing eligibility, audio, or account-wide headroom. See docs/QUICKSTART.md for the controlled test.');
process.exitCode = problems ? 1 : 0;
