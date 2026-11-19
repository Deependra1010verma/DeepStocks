import fs from 'node:fs';
const base='audit/provider-comparison';
const run=JSON.parse(fs.readFileSync(`${base}/groq.json`,'utf8'));
const review=JSON.parse(fs.readFileSync(`${base}/manual-review.json`,'utf8'));
const reviewFor=(row)=>review.reviews.find(r=>r.case===row.case&&r.model===row.model);
const median=(values)=>{const s=[...values].sort((a,b)=>a-b),n=s.length;return n?(n%2?s[(n-1)/2]:(s[n/2-1]+s[n/2])/2):null;};
const mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
const models=[...new Set(run.results.map(r=>r.model))].map(model=>{
  const rows=run.results.filter(r=>r.model===model),reviewed=rows.map(reviewFor).filter(Boolean);
  const blocked=rows.filter(r=>!r.case.endsWith('/complete-evidence'));
  const promptTokens=rows.reduce((s,r)=>s+(r.capture?.usage?.prompt_tokens??0),0);
  const completionTokens=rows.reduce((s,r)=>s+(r.capture?.usage?.completion_tokens??0),0);
  const unit=model.endsWith('120b')?[0.15,0.60]:[0.075,0.30];
  return {model,cases:rows.length,http200:rows.filter(r=>r.capture?.httpStatus===200).length,schemaAccepted:rows.filter(r=>r.schemaValid).length,rawResponsesReviewed:reviewed.length,materialFindings:reviewed.filter(r=>r.severity==='material').length,minorOnlyFindings:reviewed.filter(r=>r.severity==='minor').length,noIssueIdentified:reviewed.filter(r=>r.severity==='none').length,providerLatencyMedianMs:median(rows.map(r=>r.capture?.providerLatencyMs).filter(Number.isFinite)),providerLatencyMeanMs:mean(rows.map(r=>r.capture?.providerLatencyMs).filter(Number.isFinite)),harnessLatencyMedianMs:median(rows.map(r=>r.latencyMs)),harnessLatencyMinMs:Math.min(...rows.map(r=>r.latencyMs)),harnessLatencyMaxMs:Math.max(...rows.map(r=>r.latencyMs)),promptTokens,completionTokens,totalTokens:rows.reduce((s,r)=>s+(r.capture?.usage?.total_tokens??0),0),paidListPriceEquivalentUSD:(promptTokens*unit[0]+completionTokens*unit[1])/1000000,blockedCases:blocked.length,blockedCasesProtected:blocked.filter(r=>r.guardedReport?.verdictBadge==='WATCHLIST ONLY'&&r.guardedReport.convictionScore<=6).length,errors:rows.filter(r=>r.status==='error').map(r=>({case:r.case,code:r.code}))};
});
const pairedCases=run.results.filter(r=>r.model==='openai/gpt-oss-20b').map(row=>({case:row.case,primarySeverity:review.reviews.find(r=>r.case===row.case&&r.model==='openai/gpt-oss-120b')?.severity,secondarySeverity:reviewFor(row)?.severity}));
const issueCounts={};for(const row of review.reviews)for(const issue of row.issues)issueCounts[issue.type]=(issueCounts[issue.type]??0)+1;
const summary={at:new Date().toISOString(),version:run.version,promptHash:run.promptHash,completed:run.completed,plannedRequests:run.plannedRequests,blocked:run.blocked,models,pairedCases,issueCounts,limitations:['Exploratory single-reviewer judgment, not blinded or independently replicated.','Same synthetic instrument across six modes; these are not independent real-stock outcomes.','No trading win-rate or model-wide accuracy claim.','Six-case secondary pilot cannot establish a superior model.','Listed paid-price equivalent is not a bill; account billing tier was not verified.','Gemini generation not run in the configured free-only mode.']};
fs.writeFileSync(`${base}/summary.json`,JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
