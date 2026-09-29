import fs from 'node:fs';
import { localConfig, apiClient, privateWrite } from './config.mjs';
const {base,vars} = localConfig(), api = apiClient(base,vars.OWNER_API_KEY);
const live = process.argv.includes('--live');
if (fs.existsSync('.local/muse-api-key.txt')) throw new Error('A key already exists. Revoke/rotate it deliberately; this command will not overwrite it.');
if (live && !(await api('/v1/me')).liveReady) throw new Error('Complete activation first, or issue a simulation-only key.');
const intentPath = '.local/muse-key-intent.json';
const intent = fs.existsSync(intentPath) ? JSON.parse(fs.readFileSync(intentPath,'utf8')) : {key:crypto.randomUUID(),live};
if (intent.live !== live) throw new Error('Existing issuance intent has different permissions. Inspect owner status and reconcile first.');
privateWrite(intentPath,JSON.stringify(intent));
const r = await api('/v1/admin/credentials', {
  name:'Muse',scopes:['calls:create','calls:read','calls:answer','calls:context','calls:cancel','transcript:read'],
  live,destinations:[],maxCallCents:500,maxCommitmentCents:0,allowCommitments:false,allowFirstPerson:false,expiresInDays:30,
},intent.key);
privateWrite('.local/muse-api-key.txt',r.token+'\n');
privateWrite('.local/muse-credential.json',JSON.stringify({id:r.id,principal:r.principal},null,2)+'\n');
privateWrite('.local/muse-connect.md',fs.readFileSync('prompts/CONNECT-MUSE.md','utf8').replaceAll('YOUR_CALLING_API_URL',base));
console.log('Created '+(live?'live':'simulation-only')+' Muse credential. Secret saved ONLY in .local/muse-api-key.txt.\nPaste .local/muse-connect.md into Muse; enter the key only in its Secure Vault dialog. Expires in 30 days.');
