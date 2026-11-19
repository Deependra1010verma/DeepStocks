import mongoose from 'mongoose';
import { connectDB } from './db';
import { sendTelegramAlert, type TelegramAlertPayload } from './telegramBot';
import { withLease, recordOperation } from './operations';
interface Alert { _id: string; payload: TelegramAlertPayload; state: string; attempts: number; expiresAt: Date; purgeAt: Date; nextAttemptAt: Date; sentAt?: Date }
async function collection(){await connectDB();return mongoose.connection.db!.collection<Alert>('alert_outbox');}
export async function queueAlert(id: string, payload: TelegramAlertPayload, expiresAt: Date) {
  if (!payload.stocks.length) return;
  const col=await collection();await col.updateOne({_id:id},{$setOnInsert:{payload,state:'pending',attempts:0,expiresAt,purgeAt:new Date(+expiresAt+7*86400000),nextAttemptAt:new Date()}},{upsert:true});
}
export async function deliverAlerts(deadline=Date.now()+18000) {
  return withLease('alerts',async()=>{
    const col=await collection(),now=new Date();
    await col.updateMany({state:'pending',expiresAt:{$lte:now}},{$set:{state:'expired'}});
    const items=await col.find({state:'pending',expiresAt:{$gt:now},nextAttemptAt:{$lte:now}}).sort({nextAttemptAt:1}).limit(5).toArray();
    let sent=0;
    for(const item of items){
      if(Date.now()>deadline-8500)break;
      if(process.env.ALERTS_DRY_RUN!=='false')break;
      const delivered=await sendTelegramAlert(item.payload);
      await col.updateOne({_id:item._id,state:'pending'},{$set:{state:delivered?'sent':'pending',...(delivered?{sentAt:new Date()}:{nextAttemptAt:new Date(Date.now()+Math.min(3600,60*2**item.attempts)*1000)})},$inc:{attempts:1}});
      if(delivered)sent++;
    }
    await recordOperation('alerts',{status:'ok',sent,pending:await col.countDocuments({state:'pending'})});return {sent};
  });
}
