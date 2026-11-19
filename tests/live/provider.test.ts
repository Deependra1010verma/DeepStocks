import { it,expect,vi } from 'vitest';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { researchCases,RESEARCH_VERSION } from '../researchCases';
import { providerConfig,generateJSON } from '../../src/lib/aiProvider';
import { buildAnalysisRequest } from '../../src/lib/aiAnalyst';
import { validateEvidenceSelection } from '../../src/lib/researchEvidence';
import { enforceRiskGuards } from '../../src/lib/analysisRules';
import { AppError,operationCollection } from '../../src/lib/operations';

type Capture={httpStatus:number;providerLatencyMs:number;finishReason:string|null;rawText:string;usage:unknown};
type Result={case:string;model:string;status:'ok'|'error';code?:string;schemaValid:boolean;latencyMs:number;capture?:Capture;selection?:ReturnType<typeof validateEvidenceSelection>;guardedReport?:ReturnType<typeof enforceRiskGuards>};
const evaluated=(result:Result)=>result.status==='ok'||['AI_SCHEMA','AI_EVIDENCE','AI_TRUNCATED'].includes(result.code??'');
it.skipIf(process.env.RUN_PROVIDER_BENCHMARK!=='1')('raw explanations and guarded reports on 30 evidence scenarios',async()=>{
  const config=providerConfig(),originalModel=process.env.GROQ_MODEL;
  const inputs=researchCases.map(item=>({...item,request:buildAnalysisRequest(item.stock,item.news,'NEUTRAL')}));
  const promptHash=createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
  const models=config.provider==='groq'&&process.env.BENCHMARK_SECOND_MODEL==='1'?[config.model,'openai/gpt-oss-20b']:[config.model];
  const tasks=models.flatMap((model,index)=>inputs.filter((_,i)=>index===0||[0,6,12,18,24,25].includes(i)).map(item=>({model,item})));
  const path=`audit/provider-comparison/${config.provider}-evidence-v2.json`;
  await mkdir('audit/provider-comparison',{recursive:true});
  let results:Result[]=[],operationalAttempts:Result[]=[],startedAt=new Date().toISOString(),blocked:string|null=null,lastCall=0;
  try{const prior=JSON.parse(await readFile(path,'utf8'));if(prior.version===RESEARCH_VERSION&&prior.promptHash===promptHash){
    const previous=prior.results as Result[];
    results=previous.filter(evaluated);
    operationalAttempts=[...(prior.operationalAttempts??[]),...previous.filter(row=>!evaluated(row))];
    startedAt=prior.startedAt;
  }else if(prior.blocked==='AI_NOT_CONFIGURED')await writeFile('audit/provider-comparison/groq-preflight-missing-key.json',JSON.stringify(prior,null,2));}catch{}
  await writeFile('audit/provider-comparison/research-inputs-evidence-v2.json',JSON.stringify({version:RESEARCH_VERSION,promptHash,inputs},null,2));
  const checkpoint=()=>writeFile(path,JSON.stringify({version:RESEARCH_VERSION,promptHash,startedAt,updatedAt:new Date().toISOString(),provider:config.provider,primaryModel:config.model,plannedCases:30,plannedRequests:tasks.length,completed:results.length,blocked,results,operationalAttempts,note:'Synthetic evidence-selection test. The secondary model is a six-case paired pilot. Operational pauses leave the case pending.'},null,2));
  if(!config.configured)blocked='AI_NOT_CONFIGURED';
  let capture:Capture|undefined;
  const realFetch=globalThis.fetch;
  const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
    const start=Date.now(),response=await realFetch(input,init);
    if(String(input).startsWith('https://api.groq.com/openai/v1/chat/completions')){
      const body=await response.clone().json();capture={httpStatus:response.status,providerLatencyMs:Date.now()-start,finishReason:body.choices?.[0]?.finish_reason??null,rawText:body.choices?.[0]?.message?.content??'',usage:body.usage??null};
    }
    return response;
  });
  try{
    if(!blocked)for(const {model,item}of tasks){
      if(results.some(r=>r.case===item.name&&r.model===model))continue;
      if(config.provider==='groq')process.env.GROQ_MODEL=model;
      const reserved=Math.ceil((item.request.system.length+JSON.stringify(item.request.facts).length)/2)+1800;
      // Respect both pacing and the app's shared minute-token budget, including other app users.
      while(true){const now=Date.now(),bucket=Math.floor(now/60000),col=await operationCollection();const used=await col.findOne({_id:`ai:minute:${config.provider}:${bucket}`});const wait=Math.max(0,lastCall+31000-now,(used?.count??0)+reserved>8000?(bucket+1)*60000-now+500:0);if(!wait)break;await new Promise(resolve=>setTimeout(resolve,Math.min(wait,10000)));}
      capture=undefined;const start=Date.now();lastCall=start;
      try{
        const response=await generateJSON(item.request.system,item.request.facts,item.request.schema);
        let parsed:unknown;try{parsed=JSON.parse(response.text);}catch{throw new AppError('AI_SCHEMA','Response was not JSON.');}
        let selection;
        try {selection=validateEvidenceSelection(parsed,item.request.facts.evidence);}catch{throw new AppError('AI_EVIDENCE','Invalid evidence selection.');}
        const guardedReport=enforceRiskGuards({evidenceSelection:selection,sourceNews:item.news},item.stock);
        results.push({case:item.name,model,status:'ok',schemaValid:true,latencyMs:Date.now()-start,capture,selection,guardedReport});
      }catch(error){
        const code=error instanceof AppError?error.code:'FAILED';
        const attempt:Result={case:item.name,model,status:'error',code,schemaValid:false,latencyMs:Date.now()-start,capture};
        if(evaluated(attempt))results.push(attempt);
        else {operationalAttempts.push(attempt);blocked=code;}
      }
      await checkpoint();const latest=(blocked?operationalAttempts:results).at(-1)!;console.log(JSON.stringify({progress:results.length,planned:tasks.length,case:item.name,model,status:latest.status,code:latest.code,latencyMs:latest.latencyMs}));
      if(blocked)break;
    }
  }finally{spy.mockRestore();if(originalModel===undefined)delete process.env.GROQ_MODEL;else process.env.GROQ_MODEL=originalModel;await checkpoint();await mongoose.disconnect();}
  expect(blocked,'Research stopped at an operational limit; checkpoint preserves completed calls.').toBeNull();
  expect(results.length).toBe(tasks.length);
},2400000);
