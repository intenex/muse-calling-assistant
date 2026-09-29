import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { apiClient, serviceUrl, secretNames } from '../config.mjs';
const root = fileURLToPath(new URL('../../',import.meta.url));

test('rejects insecure or credential-bearing service origins', () => {
  for (const v of ['http://remote.example','https://key:secret@host.test','https://host.test/x','https://host.test/?token=secret','https://your-calling-assistant.example.com']) assert.throws(()=>serviceUrl(v));
  assert.equal(serviceUrl('http://127.0.0.1:8787',true),'http://127.0.0.1:8787');
});
test('HTTP helper retains mutation identity and blocks redirects/path escapes', async () => {
  let called=0;
  const api=apiClient('https://service.test','FAKE_SECRET',async (url,init)=>{
    called++; assert.equal(url,'https://service.test/v1/calls'); assert.equal(init.redirect,'error');
    assert.equal(init.headers['idempotency-key'],'same-intent');
    assert.equal(init.headers.authorization,'Bearer FAKE_SECRET');
    return Response.json({id:'fixture'});
  });
  await api('/v1/calls',{mode:'simulation'},'same-intent');
  await assert.rejects(api('/v1/../other'),/relative/);
  assert.equal(called,1);
});
test('errors suppress provider messages and secrets',async()=>{
  const api=apiClient('https://service.test','FAKE_SECRET',async()=>Response.json({error:{code:'conflict',message:'private account FAKE_SECRET'}},{status:409}));
  await assert.rejects(api('/v1/calls'),e=>e.message.includes('409')&&!e.message.includes('FAKE_SECRET')&&!e.message.includes('private account'));
  assert.ok(!secretNames.includes('LIVE_ENABLED'));
});
test('key issuance writes once privately, never prints token, refuses accidental replacement',async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'calling-setup-'));
  const calls=[];
  const server=http.createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;
    calls.push({path:req.url,key:req.headers['idempotency-key'],body:JSON.parse(text)});
    res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'fixture-id',token:'FAKE_AGENT_TOKEN',principal:{live:false}}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  function run(){return new Promise((resolve,reject)=>{
    const p=spawn(process.execPath,[path.join(root,'scripts/agent-key.mjs')],{cwd:temp,env:{...process.env,CALLING_API_URL:base}});
    let output='';p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>output+=b);p.on('error',reject);p.on('close',code=>resolve({code,output}));
  });}
  try {
    fs.writeFileSync(path.join(temp,'wrangler.jsonc'),JSON.stringify({vars:{PUBLIC_BASE_URL:base}}));
    fs.writeFileSync(path.join(temp,'.dev.vars'),'OWNER_API_KEY=FAKE_OWNER\n');
    fs.mkdirSync(path.join(temp,'prompts'));fs.copyFileSync(path.join(root,'prompts/CONNECT-MUSE.md'),path.join(temp,'prompts/CONNECT-MUSE.md'));
    const first=await run();assert.equal(first.code,0,first.output);assert.ok(!first.output.includes('FAKE_AGENT_TOKEN'));
    assert.equal(calls.length,1);assert.equal(calls[0].body.live,false);assert.equal(calls[0].body.allowCommitments,false);assert.ok(calls[0].key);
    const keyfile=path.join(temp,'.local/muse-api-key.txt');assert.equal(fs.readFileSync(keyfile,'utf8').trim(),'FAKE_AGENT_TOKEN');
    if(process.platform!=='win32')assert.equal(fs.statSync(keyfile).mode&0o777,0o600);
    const second=await run();assert.notEqual(second.code,0);assert.equal(calls.length,1);
    assert.ok(!fs.readFileSync(path.join(temp,'.local/muse-connect.md'),'utf8').includes('FAKE_AGENT_TOKEN'));
  } finally {await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true});}
});
