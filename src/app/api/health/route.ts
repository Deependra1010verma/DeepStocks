import { NextRequest, NextResponse } from 'next/server';
import { requireOwner, apiError } from '@/lib/apiSecurity';
import { operationCollection } from '@/lib/operations';
import { providerConfig } from '@/lib/aiProvider';
import { CALENDAR_VERSION, getMarketSession } from '@/lib/timezone';
export const dynamic = 'force-dynamic';
export async function GET(req: NextRequest) {
  try { requireOwner(req); const col=await operationCollection(); const jobs=await col.find({_id:{$regex:'^health:'}}).toArray();const bucket=Math.floor(Date.now()/86400000);const usage=await col.find({_id:{$in:[`ai:requests:${bucket}`,`ai:tokens:groq:${bucket}`,`ai:tokens:gemini:${bucket}`]}},{projection:{_id:1,count:1}}).toArray();return NextResponse.json({provider:providerConfig(),calendarVersion:CALENDAR_VERSION,session:getMarketSession(),jobs,usage,dailyRequestLimit:Number(process.env.AI_DAILY_REQUEST_LIMIT || 40),dailyTokenLimit:Math.min(Number(process.env.AI_DAILY_TOKEN_LIMIT || 150000),200000)},{headers:{'Cache-Control':'no-store'}}); }
  catch(error){return apiError(error);}
}
