import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const files=[...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean))];
const problems=[];
for(const file of files){
  if(/(^|\/)(\.dev\.vars(?!\.example$)|\.local|\.env(?!\.example$)|\.DS_Store)(\/|$)|\.(mp3|wav|log)$/.test(file)){problems.push(file+': private artifact');continue;}
  const body=fs.readFileSync(file,'utf8');
  if(/\b(?:sk-proj-|ghp_|gho_|github_pat_)[A-Za-z0-9_-]{20,}/.test(body)||/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(body))problems.push(file+': possible credential');
  if(/\/Users\/[^/\s]+\//.test(body))problems.push(file+': personal absolute path');
  for(const n of body.match(/\+1[2-9]\d{9}\b/g)||[])if(!/^\+1\d{3}55501\d{2}$/.test(n))problems.push(file+': non-fictional phone number');
}
const c=JSON.parse(fs.readFileSync('wrangler.jsonc','utf8'));
for(const key of ['LIVE_ENABLED','ROLLOUT_VERIFIED','ACCOUNT_HEADROOM_VERIFIED'])if(c.vars[key]!=='false')problems.push('wrangler.jsonc: template activation is enabled');
if(c.vars.CONTROLLED_TEST_NUMBER||Number(c.vars.CONTROLLED_TEST_UNTIL))problems.push('wrangler.jsonc: controlled test configured');
if(c.vars.PUBLIC_BASE_URL!=='https://your-calling-assistant.example.com')problems.push('wrangler.jsonc: replace personal host with template placeholder before publishing');
if(files.some(p=>p.startsWith('.github/workflows/')))problems.push('Unexpected workflow: review hosted triggers and cost before publication');
if(problems.length){console.error(problems.join('\n'));process.exitCode=1;}else console.log(`Public template audit passed: ${files.length} files. This pattern scan supplements human review; it is not a complete secret detector.`);
