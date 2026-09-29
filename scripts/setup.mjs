import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { config, serviceUrl, privateWrite } from './config.mjs';
import { readLocalEnv } from './local-env.mjs';
if (!process.stdin.isTTY) throw new Error('Run setup in an interactive terminal. For scripted setup use .dev.vars.example.');
let muted = false;
const out = new Writable({write(chunk, encoding, done) { if (!muted) process.stdout.write(chunk, encoding); done(); }});
const rl = readline.createInterface({input:process.stdin, output:out, terminal:true});
const previous = fs.existsSync('.dev.vars') ? readLocalEnv() : {};
async function ask(label, fallback = '', secret = false) {
  process.stdout.write(`${label}${fallback ? ' [Enter keeps existing]' : ''}: `); muted = secret;
  try { return (await rl.question('')).trim() || fallback; }
  finally { muted = false; if (secret) process.stdout.write('\n'); }
}
try {
  const c = config();
  if (c.vars.LIVE_ENABLED === 'true') throw new Error('Already live. Edit configuration deliberately; setup will not reset an active installation.');
  console.log('Local setup only: no deployment, purchase, paid requests, or calls. Secret input is hidden. Leave provider fields blank for simulation.');
  const worker = await ask('Worker name', c.name);
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(worker)) throw new Error('Worker name: 3–63 lowercase letters, numbers, hyphens.');
  const origin = await ask('HTTPS Worker URL (blank keeps placeholder for local-only demo)', c.vars.PUBLIC_BASE_URL);
  if (!origin.endsWith('example.com')) serviceUrl(origin);
  const values = {...previous};
  for (const name of ['OWNER_API_KEY', 'MEDIA_SIGNING_KEY', 'CALLBACK_SIGNING_KEY']) values[name] ||= randomBytes(32).toString('hex');
  for (const [name, label] of [
    ['OPENAI_API_KEY','OpenAI project API key'], ['TELNYX_API_KEY','Telnyx API v2 key'],
    ['TELNYX_PUBLIC_KEY','Telnyx Ed25519 webhook public key'], ['TELNYX_CONNECTION_ID','Telnyx Voice API application / connection ID'],
    ['TELNYX_FROM_NUMBER','Your Telnyx outbound number (+1…)']
  ]) values[name] = await ask(label, previous[name] || '', true);
  if (values.TELNYX_FROM_NUMBER && !/^\+1[2-9]\d{9}$/.test(values.TELNYX_FROM_NUMBER)) throw new Error('Use an E.164 US number.');
  Object.assign(values, {LIVE_ENABLED:'false',ACCOUNT_HEADROOM_VERIFIED:'false',ROLLOUT_VERIFIED:'false',CONTROLLED_TEST_NUMBER:'',CONTROLLED_TEST_UNTIL:'0'});
  if (Object.values(values).some(v => /[\r\n"']/.test(v))) throw new Error('Values must be single-line strings without quotes.');
  privateWrite('.dev.vars', Object.entries(values).map(([k,v]) => `${k}=${v}`).join('\n')+'\n');
  c.name = worker; c.vars.PUBLIC_BASE_URL = origin.replace(/\/$/,'');
  fs.writeFileSync('wrangler.jsonc', JSON.stringify(c,null,2)+'\n');
  console.log('Saved private .dev.vars. No secret values printed.\nLocal demo: npm run dev\nHosted setup: docs/QUICKSTART.md (login → deploy -- --bootstrap → secrets → doctor).');
} finally { rl.close(); }
