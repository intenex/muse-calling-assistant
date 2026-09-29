import fs from 'node:fs';
import { localConfig, apiClient } from './config.mjs';
const [verb,path,file,key] = process.argv.slice(2);
if (!['get','post'].includes(verb) || !path || (verb==='post' && (!file || !key))) throw new Error('Usage: npm run pca -- get /v1/PATH | post /v1/PATH JSON_FILE STABLE_IDEMPOTENCY_KEY');
const {base,vars} = localConfig();
if (path === '/v1/admin/credentials' && verb==='post') throw new Error('Use agent:key or a secure admin client; credential responses must never print to stdout.');
console.log(JSON.stringify(await apiClient(base,process.env.CALLING_API_KEY || vars.OWNER_API_KEY)(path,verb==='post'?JSON.parse(fs.readFileSync(file,'utf8')):undefined,key),null,2));
