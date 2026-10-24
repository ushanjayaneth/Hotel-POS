import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Database} from 'firebase-admin/database';
import {FirebaseMonitorStore,type Projection} from '../server/monitor/store';

type Value = {revision?:number;json?:string;[key:string]:unknown}|null;
const copy=<T>(value:T):T=>structuredClone(value);

/** Models the installed RTDB SDK: get() evicts an unwatched value, while
 * transaction() runs immediately on the local cache and retries server CAS. */
class EvictingRealtimeDatabase {
  constructor(readonly server=new Map<string,Value>()){}
  readonly cache=new Map<string,Value>();
  readonly listeners=new Map<string,Set<(snapshot:{val:()=>Value})=>void>>();
  denyReads=false;
  failPublish=false;
  ref(path:string){
    const db=this;
    const snapshot=(value:Value)=>({val:()=>copy(value)});
    return {
      child(child:string){return db.ref(`${path}/${child}`);},
      async get(){return snapshot(db.server.get(path)??null);},
      on(_event:string,callback:(snapshot:{val:()=>Value})=>void){
        const listeners=db.listeners.get(path)??new Set();listeners.add(callback);db.listeners.set(path,listeners);
        queueMicrotask(()=>{
          if(!listeners.has(callback))return;
          const value=copy(db.server.get(path)??null);db.cache.set(path,value);callback(snapshot(value));
        });
        return callback;
      },
      off(_event:string,callback:(snapshot:{val:()=>Value})=>void){
        const listeners=db.listeners.get(path);listeners?.delete(callback);
        if(!listeners?.size){db.listeners.delete(path);db.cache.delete(path);}
      },
      once(event:string):Promise<{val:()=>Value}>{
        if(db.denyReads)return Promise.reject(new Error('Read permission denied.'));
        return new Promise(resolve=>{
          const ref=db.ref(path),callback=(value:{val:()=>Value})=>{ref.off(event,callback);resolve(value);};
          ref.on(event,callback);
        });
      },
      async transaction(update:(current:Value)=>Value|undefined){
        if(db.failPublish&&path.includes('/index/'))throw new Error('Index publication interrupted.');
        let input=copy(db.cache.get(path)??null);
        for(let attempt=0;attempt<10;attempt++){
          const next=update(copy(input));
          if(next===undefined)return {committed:false,snapshot:snapshot(input)};
          // Concurrent workers can all evaluate the same prior revision.
          await Promise.resolve();
          const current=db.server.get(path)??null;
          if(JSON.stringify(current)!==JSON.stringify(input)){input=copy(current);continue;}
          db.server.set(path,copy(next));
          if(db.listeners.get(path)?.size)db.cache.set(path,copy(next));
          return {committed:true,snapshot:snapshot(next)};
        }
        throw new Error('Transaction retries exhausted.');
      },
    };
  }
  database(){return this as unknown as Database;}
}
function projection(sourceId='shop-source',revision=1):Projection{
  const timestamp='2026-10-23T00:00:00.000Z';
  return {revision,source:{sourceId,workspaceId:'workspace',businessName:'Test Hotel',deviceName:'Counter',epoch:'epoch',sequence:1,ready:true,revoked:false,shared:true,dataVersion:revision,updatedAt:timestamp,lastSeenAt:timestamp},metadata:{settings:{businessName:'Test Hotel'}},commands:{},records:{}};
}
function seed(db:EvictingRealtimeDatabase,value:Projection){db.server.set(`hotelMonitor/hotel/sources/${value.source.sourceId}`,{revision:value.revision,json:JSON.stringify(value)});}

test('Firebase cold-start compare-and-set retains its initial value until the transaction finishes',async()=>{
  const db=new EvictingRealtimeDatabase(),store=new FirebaseMonitorStore(db.database(),'hotel');
  seed(db,projection());
  const prior=(await store.get('shop-source'))!;assert.equal(prior.revision,1);assert.equal(db.cache.size,0);
  const next={...prior,revision:2,source:{...prior.source,dataVersion:2}};
  assert.equal(await store.replace('shop-source',1,next),true);
  assert.equal((await store.get('shop-source'))!.revision,2);
  assert.equal(db.listeners.size,0);assert.equal(db.cache.size,0);
});

test('four Firebase workers racing the same revision commit once and release their temporary listeners',async()=>{
  const db=new EvictingRealtimeDatabase();seed(db,projection());
  const workers=Array.from({length:4},()=>new EvictingRealtimeDatabase(db.server));
  const stores=workers.map(worker=>new FirebaseMonitorStore(worker.database(),'hotel'));
  const priors=await Promise.all(stores.map(store=>store.get('shop-source')));
  const results=await Promise.all(stores.map((store,index)=>store.replace('shop-source',1,{...priors[index]!,revision:2,metadata:{...priors[index]!.metadata,winner:index},source:{...priors[index]!.source,dataVersion:2}})));
  assert.deepEqual(results.sort(),[false,false,false,true]);
  assert.equal((await stores[0].get('shop-source'))!.revision,2);
  for(const worker of workers){assert.equal(worker.listeners.size,0);assert.equal(worker.cache.size,0);}
});

test('Firebase creation races cannot replace an existing source or recreate a missing revision',async()=>{
  const db=new EvictingRealtimeDatabase(),store=new FirebaseMonitorStore(db.database(),'hotel');
  const results=await Promise.all([store.replace('shop-source',null,projection()),store.replace('shop-source',null,{...projection(),metadata:{attempt:'other-device'}})]);
  assert.deepEqual(results.sort(),[false,true]);
  const saved=(await store.get('shop-source'))!;
  assert.equal(await store.replace('shop-source',null,{...projection(),metadata:{attempt:'replacement'}}),false);
  assert.deepEqual(await store.get('shop-source'),saved);
  assert.equal(await store.replace('missing-source',1,projection('missing-source',2)),false);
  assert.equal(await store.get('missing-source'),null);
  assert.equal(db.listeners.size,0);
});

test('Firebase temporary listeners are removed after read or index-publication failures',async()=>{
  const db=new EvictingRealtimeDatabase(),store=new FirebaseMonitorStore(db.database(),'hotel');seed(db,projection());
  db.denyReads=true;
  await assert.rejects(store.replace('shop-source',1,projection('shop-source',2)),/Read permission denied/);
  assert.equal(db.listeners.size,0);assert.equal((await store.get('shop-source'))!.revision,1);
  db.denyReads=false;db.failPublish=true;
  await assert.rejects(store.replace('shop-source',1,projection('shop-source',2)),/publication interrupted/);
  assert.equal(db.listeners.size,0);assert.equal(db.cache.size,0);
  assert.equal((await store.get('shop-source'))!.revision,2);
});
