// Maintains cache/job expiry indexes only. Does not delete user watchlists or ledger history.
import mongoose from 'mongoose';
if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI required');
try {
  await mongoose.connect(process.env.MONGODB_URI,{autoIndex:false,serverSelectionTimeoutMS:10000,maxPoolSize:1});
  const db=mongoose.connection.db;
  const check=process.argv.includes('--check');
  if(check){
    for(const [collection,field] of [['aianalysiscaches','expiresAt'],['operations','expiresAt'],['alert_outbox','purgeAt']]){
      const exists=(await db.listCollections({name:collection}).toArray()).length>0;
      const indexes=exists?await db.collection(collection).indexes():[];
      const ready=indexes.some(i=>i.key[field]===1&&i.expireAfterSeconds===0);
      console.log(`${collection}.${field}: ${ready?'ready':'migration required'}`);
    }
    await mongoose.disconnect();process.exit(0);
  }
  for(const [collection,field] of [['aianalysiscaches','expiresAt'],['operations','expiresAt'],['alert_outbox','purgeAt']]){
    if(!(await db.listCollections({name:collection}).toArray()).length)await db.createCollection(collection);
    const col=db.collection(collection),indexes=await col.indexes();
    const existing=indexes.find(i=>Object.keys(i.key).length===1&&i.key[field]===1);
    if(existing&&existing.expireAfterSeconds!==0)await db.command({collMod:collection,index:{name:existing.name,expireAfterSeconds:0}});
    else if(!existing)await col.createIndex({[field]:1},{expireAfterSeconds:0});
    console.log(`${collection}.${field}: TTL verified`);
  }
  // Retain delivery IDs beyond validity so an expired alert cannot be requeued the same day.
  await db.collection('alert_outbox').updateMany({purgeAt:{$exists:false}},{$set:{purgeAt:new Date(Date.now()+7*86400000)}});
  for(const [collection,key] of [['aianalysiscaches',{symbol:1,mode:1,marketRegime:1}],['scansnapshots',{mode:1,sector:1}],['stockcaches',{symbol:1,date:1}],['watchlists',{userId:1,symbol:1}],['signalledgers',{symbol:1,mode:1,signalDate:1}]]){
    await db.collection(collection).createIndex(key,{unique:true});
    console.log(`${collection}: identity index verified`);
  }
} catch {console.error('Index setup failed; check database connectivity and index-management permissions.');process.exitCode=1;}
finally {await mongoose.disconnect();}
