// Read-only local smoke test: no login-budget mutation, scans, AI generation or alerts.
import { createHmac } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
const origin=process.env.TEST_BASE_URL??'http://127.0.0.1:3100';
if(!['127.0.0.1','localhost'].includes(new URL(origin).hostname))throw new Error('Local smoke test only');
const rows=[];
for(const path of ['/api/scan','/api/watchlist','/api/ledger','/api/health','/api/cron/sync-eod','/api/cron/preopen']){
  const response=await fetch(origin+path,{signal:AbortSignal.timeout(10000)});
  rows.push({path,authenticated:false,status:response.status,pass:response.status===401});
}
const payload=Buffer.from(JSON.stringify({user:'owner',expires:Date.now()+43200000})).toString('base64url');
const signature=createHmac('sha256',process.env.SESSION_SECRET+process.env.APP_ACCESS_PASSWORD).update(payload).digest('base64url');
for(const path of ['/api/session','/api/health','/api/scan?mode=swing_breakout','/api/ledger']){
  const response=await fetch(origin+path,{headers:{cookie:`deepstocks_session=${payload}.${signature}`},signal:AbortSignal.timeout(15000)});
  const body=await response.json();
  rows.push({path,authenticated:true,status:response.status,pass:response.ok,...(path==='/api/health'?{aiConfigured:body.provider?.configured}:{}),...(path==='/api/ledger'?{closed:body.stats?.closed,winRate:body.stats?.winRate}:{})});
}
await mkdir('audit/2026-11-18',{recursive:true});await writeFile('audit/2026-11-18/private-smoke.json',JSON.stringify({at:new Date(),rows},null,2));
console.log(JSON.stringify({checks:rows.length,passed:rows.filter(r=>r.pass).length,failed:rows.filter(r=>!r.pass).length}));
if(rows.some(r=>!r.pass))process.exitCode=1;
