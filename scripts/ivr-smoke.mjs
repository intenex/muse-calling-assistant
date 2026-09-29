import fs from 'node:fs';
import { localConfig, apiClient, privateWrite } from './config.mjs';
const {base,vars} = localConfig(), api = apiClient(base,process.env.CALLING_API_KEY || vars.OWNER_API_KEY);
const brief = JSON.parse(fs.readFileSync('examples/ivr-simulation.json','utf8'));
if (brief.mode !== 'simulation') throw new Error('This helper only creates simulations.');
const intentFile = '.local/ivr-smoke-intent.json';
const intent = fs.existsSync(intentFile) ? JSON.parse(fs.readFileSync(intentFile,'utf8')) : {key:crypto.randomUUID()};
privateWrite(intentFile,JSON.stringify(intent));
const call = await api('/v1/calls',brief,intent.key);
console.log('Simulation: '+call.id+'; no phone or model calls.');
const end = Date.now()+135000;
while (Date.now()<end) {
  const s = await api('/v1/calls/'+call.id), m = s.ivr;
  if (m?.status==='pending' && m.expiresAt>Date.now()) await api(`/v1/calls/${call.id}/dtmf`,{expectedRevision:s.revision,menuId:m.id,digits:m.kind==='input'?'6204#':'2',...(m.kind==='input'?{factId:'test-reference'}:{})},`smoke:${call.id}:${m.id}`);
  if (['completed','cancelled','failed','uncertain'].includes(s.status) && s.result?.finalized!==false) {
    privateWrite('.local/ivr-smoke-result.json',JSON.stringify(s,null,2)+'\n');
    console.log(JSON.stringify({status:s.status,outcome:s.result?.outcome,costCents:s.usage.costCents}));
    process.exit(s.result?.outcome==='completed'?0:1);
  }
  await new Promise(r=>setTimeout(r,1000));
}
throw new Error('Bounded smoke window expired. Inspect the saved call; do not redial.');
