/** Compatibility helper. Application AI calls use aiProvider (shared budgets/leases).
 * Quotas belong to the provider project; never rotate keys to bypass them.
 */
import { GoogleGenAI } from '@google/genai';
import { AppError } from './operations';
import { classifyProviderError } from './aiProvider';
function keys(): string[] {
  return [...new Set(Object.entries(process.env).filter(([name,value])=>/^GEMINI_API_KEY(?:_\d+)?$/.test(name)&&value?.trim()).sort(([a],[b])=>a.localeCompare(b,undefined,{numeric:true})).map(([,value])=>value!.trim()))];
}
export async function withGeminiKey<T>(fn: (ai: GoogleGenAI)=>Promise<T>): Promise<T> {
  if(process.env.AI_FREE_ONLY!=='false')throw new AppError('AI_FREE_ONLY','Gemini requires an explicit server setting.');
  const configured=keys().slice(0,2);
  if(!configured.length)throw new AppError('AI_NOT_CONFIGURED','Gemini is not configured.');
  for(let index=0;index<configured.length;index++){
    try{return await fn(new GoogleGenAI({apiKey:configured[index],httpOptions:{timeout:22000}}));}
    catch(error){const safe=classifyProviderError(Number((error as {status?:number}).status??0),String(error));if(safe.code!=='AI_CREDENTIALS'||index===configured.length-1)throw safe;}
  }
  throw new AppError('AI_UNAVAILABLE','AI unavailable.');
}
export function poolStatus(){return {configuredKeys:keys().length,maximumCredentialAttempts:2,quotaRotation:false};}
