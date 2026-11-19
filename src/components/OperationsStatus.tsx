'use client';
import { useEffect, useState } from 'react';
type Job = { _id:string; status?:string; stage?:string; code?:string|null; latencyMs?:number; updatedAt?:string; coverage?:{verified?:number; requested?:number} };
type Health={provider?:{provider:string;model:string;configured:boolean};calendarVersion?:string;dailyRequestLimit?:number;dailyTokenLimit?:number;jobs?:Job[];usage?:Array<{_id:string;count?:number}>};
export default function OperationsStatus(){
  const [health,setHealth]=useState<Health|null>(null),[error,setError]=useState(false);
  useEffect(()=>{let active=true;const read=async()=>{try{const r=await fetch('/api/health',{signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error();const data=await r.json();if(active){setHealth(data);setError(false);}}catch{if(active)setError(true);}};void read();const timer=setInterval(()=>void read(),60000);return()=>{active=false;clearInterval(timer);};},[]);
  const requests=health?.usage?.find(item=>item._id.startsWith('ai:requests:'))?.count??0;
  const limit=health?.dailyRequestLimit;
  const tokens=health?.usage?.find(item=>item._id.startsWith(`ai:tokens:${health?.provider?.provider}:`))?.count??0;
  const tokenLimit=health?.dailyTokenLimit;
  const budgetFull=(limit!=null&&limit>0&&requests>=limit)||(tokenLimit!=null&&tokenLimit>0&&tokens+1800>tokenLimit);
  return <details className="text-[11px] text-slate-400"><summary className="cursor-pointer py-1">System status{error?' · unavailable':budgetFull?' · AI daily limit reached':health?.provider?.configured?' · AI configured':' · AI not configured'}</summary><div className="space-y-1 py-2">
    <p>{health?.provider?`${health.provider.provider} / ${health.provider.model}`:'Provider status unavailable'} · {health?.calendarVersion??'Calendar status unavailable'}</p>
    {health?.usage?.map(item=><p key={item._id}>{item._id.startsWith('ai:requests:')?'AI requests reserved today':'AI token budget reserved today'}: {item.count??0}</p>)}
    {health?.jobs?.length?health.jobs.map(job=><p key={job._id}>
      {job._id.replace('health:','')} · {job.status??'unknown'}
      {job.stage&&` · ${job.stage}`}
      {job.status==='failed'&&job.code&&` · ${job.code}`}
      {job.coverage?.verified!=null&&` · ${job.coverage.verified}/${job.coverage.requested} verified`}
      {job.latencyMs!=null&&` · ${(job.latencyMs/1000).toFixed(1)}s`}
      {' · '}{job.updatedAt?new Date(job.updatedAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})+' IST':'no timestamp'}
    </p>):<p>No job heartbeat available. External scheduling must be configured separately.</p>}
    {error&&<p role="alert">Health storage could not be reached. Previously displayed status may be stale.</p>}
  </div></details>;
}
