import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { Watchlist } from '@/lib/models/Watchlist';
import { requireOwner, authorizeRequest, apiError, readBody } from '@/lib/apiSecurity';
import { validSymbol, validMode, resolveStock } from '@/lib/stockService';
import { getTradePlan } from '@/lib/tradePlan';
import { AppError } from '@/lib/operations';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function GET(req: NextRequest){try{requireOwner(req);await connectDB();return NextResponse.json({items:await Watchlist.find({userId:{$in:['owner','local']}}).sort({createdAt:-1}).limit(200).lean()});}catch(e){return apiError(e);}}
export async function POST(req: NextRequest){try{
 const userId=await authorizeRequest(req,'watchlist',10);const body=await readBody(req);
 if(Object.keys(body).some(k=>!['symbol','mode','note','alertEnabled'].includes(k)))throw new AppError('INVALID_REQUEST','Unsupported watchlist fields.',400);
 const symbol=validSymbol(body.symbol),mode=validMode(body.mode);const stock=await resolveStock(symbol,mode),plan=getTradePlan(stock);
 if(!plan&&mode!=='longterm')throw new AppError('INVALID_PLAN','Valid levels are required to save a price zone.',422);
 const fields={mode,note:typeof body.note==='string'?body.note.slice(0,500):'',alertEnabled:!!plan&&body.alertEnabled===true};
 const update=plan?{$set:{...fields,zoneLow:plan.entryLow,zoneHigh:plan.entryHigh}}:{$set:fields,$unset:{zoneLow:1,zoneHigh:1}};
 await connectDB();const item=await Watchlist.findOneAndUpdate({userId,symbol},update,{upsert:true,new:true,runValidators:true}).lean();return NextResponse.json({item});
 }catch(e){return apiError(e);}}
export async function DELETE(req: NextRequest){try{await authorizeRequest(req,'watchlist',10);const symbol=validSymbol(req.nextUrl.searchParams.get('symbol'));await connectDB();await Watchlist.deleteMany({userId:{$in:['owner','local']},symbol});return NextResponse.json({ok:true});}catch(e){return apiError(e);}}
