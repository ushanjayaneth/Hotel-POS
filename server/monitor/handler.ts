import {createHash,createHmac,randomUUID,scryptSync,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {CLOUD_MONITOR_KINDS,CLOUD_MONITOR_MAX_BYTES,type CloudPush,type CloudSource} from '../../shared/cloud-monitor.js';
import {firebaseMonitorStore,recordKey,type MonitorStore,type Projection} from './store.js';
import {monitorBootstrap,monitorCommand} from './engine.js';

const id=z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const change=z.object({kind:z.enum(CLOUD_MONITOR_KINDS),id:z.string().min(1).max(160),branchId:z.string().max(160).nullable(),value:z.record(z.string(),z.unknown())}).strict();
const push=z.object({sourceId:id,epoch:id,sequence:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),eventId:id,ready:z.boolean(),changes:z.array(change).max(1000)}).strict();
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const stable=(value:unknown):string=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?`[${value.map(stable).join(',')}]`:`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable((value as Record<string,unknown>)[key])}`).join(',')}}`;
const now=()=>new Date().toISOString();
const fail=(message:string,status=400,code='VALIDATION_ERROR'):never=>{throw Object.assign(new Error(message),{status,code});};
const check=(condition:unknown,message:string,status=400,code?:string):void=>{if(!condition)fail(message,status,code);};
const constant=(a:string,b:string)=>timingSafeEqual(Buffer.from(hash(a),'hex'),Buffer.from(hash(b),'hex'));
function validateData(value:unknown,depth=0):void {
  check(depth<=16,'Cloud record nesting is too deep.');
  if(value===null||typeof value==='boolean'||typeof value==='string')return;
  if(typeof value==='number'){check(Number.isFinite(value),'Invalid cloud number.');return;}
  if(Array.isArray(value)){check(value.length<=10000,'Cloud array is too large.');for(const child of value)validateData(child,depth+1);return;}
  check(typeof value==='object','Unsupported cloud value.');
  for(const [key,child] of Object.entries(value as object)) {
    check(!['__proto__','prototype','constructor','pin','password','salt','hash','token','private_key'].includes(key.toLowerCase()),'A cloud record contains a credential field.');
    validateData(child,depth+1);
  }
}
export interface MonitorOptions {store?:MonitorStore;env?:NodeJS.ProcessEnv}
export function createMonitorHandler(options:MonitorOptions={}) {
  const env=options.env??process.env;
  const missing=()=>[
    !env.CLOUD_OWNER_EMAIL&&'CLOUD_OWNER_EMAIL',
    !(env.CLOUD_OWNER_PASSWORD_HASH||env.CLOUD_OWNER_PASSWORD)&&'CLOUD_OWNER_PASSWORD_HASH',
    (!env.CLOUD_SESSION_SECRET||env.CLOUD_SESSION_SECRET.length<32)&&'CLOUD_SESSION_SECRET',
    !options.store&&!env.FIREBASE_DATABASE_URL&&'FIREBASE_DATABASE_URL',
    !options.store&&!env.FIREBASE_SERVICE_ACCOUNT_JSON&&'FIREBASE_SERVICE_ACCOUNT_JSON',
  ].filter(Boolean) as string[];
  const version=()=>hash(`${env.CLOUD_OWNER_EMAIL}:${env.CLOUD_OWNER_PASSWORD_HASH??env.CLOUD_OWNER_PASSWORD}`);
  const sign=(payload:Record<string,unknown>)=>{
    const text=Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${text}.${createHmac('sha256',env.CLOUD_SESSION_SECRET!).update(text).digest('base64url')}`;
  };
  const verify=(token:string,purpose:string):Record<string,any>|null=>{
    try{const [text,signature,...rest]=token.split('.');if(rest.length||!text||!signature||!constant(signature,createHmac('sha256',env.CLOUD_SESSION_SECRET!).update(text).digest('base64url')))return null;
      const value=JSON.parse(Buffer.from(text,'base64url').toString());return value.purpose===purpose&&value.exp>Date.now()&&value.version===version()?value:null;
    }catch{return null;}
  };
  const owner=(request:Request)=>{
    const cookie=request.headers.get('cookie')?.split(';').map(part=>part.trim()).find(part=>part.startsWith('hotel-cloud='))?.slice(12)??'';
    check(verify(cookie,'owner'),'Sign in to the cloud owner account.',401,'UNAUTHENTICATED');
  };
  const passwordValid=(password:string)=>{
    if(env.CLOUD_OWNER_PASSWORD_HASH){try{const [format,salt,digest]=env.CLOUD_OWNER_PASSWORD_HASH.split('$');return format==='scrypt'&&salt.length===64&&digest.length===128&&constant(scryptSync(password,Buffer.from(salt,'hex'),64).toString('hex'),digest);}catch{return false;}}
    return Boolean(env.CLOUD_OWNER_PASSWORD&&env.CLOUD_OWNER_PASSWORD.length>=12&&constant(password,env.CLOUD_OWNER_PASSWORD));
  };
  return async(request:Request):Promise<Response>=>{
    const headers:Record<string,string>={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
    const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers});
    try{
      const url=new URL(request.url),action=url.searchParams.get('action')??'status',method=request.method.toUpperCase();
      if(action==='status'&&method==='GET')return reply({configured:missing().length===0,missing:missing()});
      if(missing().length)return reply({error:'Cloud monitoring is not configured on this server.',code:'CLOUD_NOT_CONFIGURED',missing:missing()},503);
      check(/^[A-Za-z0-9_-]{1,80}$/.test(env.CLOUD_TENANT_ID??'hotel'),'Invalid cloud tenant configuration.',503);
      const store=options.store??firebaseMonitorStore(env);
      const mutating=method!=='GET';
      if(mutating){check(request.headers.get('content-type')?.split(';')[0]==='application/json','Send JSON data.',415);}
      if(mutating&&!['push','heartbeat'].includes(action))check(request.headers.get('origin')===url.origin,'This request must come from the same site.',403,'INVALID_ORIGIN');
      let body:any={};
      if(mutating){const text=await request.text();check(Buffer.byteLength(text)<=CLOUD_MONITOR_MAX_BYTES,'Cloud packet exceeds 700 KB.',413);try{body=JSON.parse(text);}catch{fail('Invalid JSON request.');}check(body&&typeof body==='object'&&!Array.isArray(body),'Invalid request body.');}
      if(action==='login'&&method==='POST'){
        const input=z.object({email:z.string().max(254),password:z.string().max(512)}).strict().parse(body);
        const ip=hash(request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()??'local');
        check(await store.rate('login-global',150,15*60000),'Too many sign-in attempts. Try again later.',429,'RATE_LIMITED');
        check(await store.rate(`login-${ip}`,12,15*60000),'Too many sign-in attempts. Try again later.',429,'RATE_LIMITED');
        check(constant(input.email.trim().toLowerCase(),env.CLOUD_OWNER_EMAIL!.trim().toLowerCase())&&passwordValid(input.password),'Cloud email or password is incorrect.',401,'INVALID_CREDENTIALS');
        headers['Set-Cookie']=`hotel-cloud=${sign({purpose:'owner',version:version(),exp:Date.now()+12*3600000})}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${url.protocol==='https:'?'; Secure':''}`;
        return reply({ok:true});
      }
      if(action==='session'&&method==='GET'){try{owner(request);return reply({authenticated:true});}catch{return reply({authenticated:false});}}
      if(action==='logout'&&method==='POST'){headers['Set-Cookie']='hotel-cloud=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';return reply({ok:true});}
      if(['push','heartbeat'].includes(action)&&method==='POST'){
        const bearer=request.headers.get('authorization')?.replace(/^Bearer /,'')??'';
        const token=verify(bearer,'owner-paired-writer-v2');
        check(!verify(bearer,'writer'),'This device uses an older cloud connection. Reconnect it in Settings with the owner account. Pending local changes have not been deleted.',401,'DEVICE_RECONNECT_REQUIRED');
        check(token,'The device connection has expired. Reconnect in Settings.',401,'INVALID_DEVICE');
        const sourceId=id.parse(body.sourceId),epoch=id.parse(body.epoch);
        check(token!.sourceId===sourceId&&token!.epoch===epoch,'Device connection does not match this workspace.',403);
        if(action==='heartbeat'){
          const source=(await store.list()).find(source=>source.sourceId===sourceId);
          check(source&&!source.revoked&&source.epoch===epoch,'This device connection was revoked.',401,'DEVICE_REVOKED');
          const timestamp=now();await store.touch(sourceId,timestamp);return reply({lastSeenAt:timestamp,shared:Boolean(source?.shared)});
        }
        const input=action==='push'?push.parse(body):null;
        if(input)for(const row of input.changes){check(row.value.id===row.id||row.kind==='settings','Cloud record ID mismatch.');validateData(row.value);}
        for(let attempt=0;attempt<6;attempt++){
          const projection=await store.get(sourceId);
          check(projection&&!projection.source.revoked&&projection.source.epoch===epoch,'This device connection was revoked.',401,'DEVICE_REVOKED');
          const next=structuredClone(projection!);
          if(input){
            const digest=hash(stable(input));
            if(next.lastEvent?.id===input.eventId){
              check(next.lastEvent?.hash===digest,'Packet replay differs from the saved packet.',409,'SEQUENCE_CONFLICT');
              return reply({sequence:input.sequence,updatedAt:next.source.updatedAt});
            }
            for(const row of input.changes){
              const key=recordKey(row.kind,row.id);
              if(row.value.deleted===true)delete next.records[key];
              else {
                const existing=next.records[key];
                const existingTime=(existing?.value as any)?.updatedAt||(existing?.value as any)?.createdAt||'';
                const incomingTime=(row.value as any)?.updatedAt||(row.value as any)?.createdAt||'';
                if(!existing||!existingTime||!incomingTime||incomingTime>=existingTime){
                  next.records[key]=row;
                }
              }
              if(row.kind==='settings')next.metadata.settings=row.value;
            }
            next.source.sequence=Math.max(next.source.sequence,input.sequence);
            next.source.ready=input.ready;
            next.source.updatedAt=now();
            next.source.dataVersion=(next.source.dataVersion??0)+1;
            next.lastEvent={id:input.eventId,hash:digest};
          }
          next.source.lastSeenAt=now();next.revision++;
          if(await store.replace(sourceId,projection!.revision,next))return reply(input?{sequence:input.sequence,updatedAt:next.source.updatedAt}:{lastSeenAt:next.source.lastSeenAt});
        }
        fail('Another device changed this workspace. Refresh and try again.',409,'CLOUD_BUSY');
      }
      if(action==='active-source'&&method==='GET'){
        const list=(await store.list()).filter(source=>!source.revoked);
        let shared=list.find(source=>source.shared)||list[0]||null;
        if(!shared){
          const sourceId='main-store';
          const epoch=randomUUID(),timestamp=now();
          const source:CloudSource={sourceId,workspaceId:'ws-main',businessName:'Hotel POS',deviceName:'Primary Store',epoch,sequence:0,ready:true,updatedAt:timestamp,lastSeenAt:timestamp,revoked:false,shared:true};
          const projection:Projection={revision:1,source,records:{},metadata:{deviceId:sourceId},commands:{}};
          await store.replace(sourceId,null,projection);
          shared=source;
        }
        return reply({sourceId:shared.sourceId,shared:true});
      }
      if(action==='auto-enroll'&&method==='POST'){
        const input=z.object({sourceId:id.optional(),businessName:z.string().trim().min(1).max(100).optional(),deviceName:z.string().trim().min(1).max(100).optional(),workspaceId:id.optional()}).parse(body);
        const list=(await store.list()).filter(source=>!source.revoked);
        let target=list.find(source=>source.shared)||list[0]||null;
        const epoch=randomUUID(),timestamp=now();
        if(!target){
          const targetSourceId=input.sourceId||'main-store';
          const source:CloudSource={sourceId:targetSourceId,workspaceId:input.workspaceId||'ws-main',businessName:input.businessName||'Hotel POS',deviceName:input.deviceName||'Counter',epoch,sequence:0,ready:true,updatedAt:timestamp,lastSeenAt:timestamp,revoked:false,shared:true};
          const projection:Projection={revision:1,source,records:{},metadata:{deviceId:targetSourceId},commands:{}};
          await store.replace(targetSourceId,null,projection);
          target=source;
        }
        return reply({sourceId:target.sourceId,epoch:target.epoch,token:sign({purpose:'owner-paired-writer-v2',sourceId:target.sourceId,epoch:target.epoch,version:version(),exp:Date.now()+365*86400000})});
      }
      if(action==='snapshot'&&method==='GET'){
        const targetId=id.parse(url.searchParams.get('sourceId')??body.sourceId);
        const projection=await store.get(targetId);check(projection&&!projection.source.revoked,'Workspace not found.',404);
        return reply({source:projection!.source,records:Object.values(projection!.records),settings:projection!.metadata?.settings??null,dataVersion:projection!.source.dataVersion??0});
      }
      owner(request);
      if(action==='sources'&&method==='GET')return reply({sources:(await store.list()).filter(source=>!source.revoked)});
      if(action==='enroll'&&method==='POST'){
        const input=z.object({sourceId:id,businessName:z.string().trim().min(2).max(100),deviceName:z.string().trim().min(2).max(100),workspaceId:id}).strict().parse(body);
        check(!await store.get(input.sourceId),'This device is already linked. Revoke its old connection before pairing with a new source ID.',409,'ALREADY_LINKED');
        const epoch=randomUUID(),timestamp=now();
        const source:CloudSource={...input,epoch,sequence:0,ready:false,updatedAt:timestamp,lastSeenAt:timestamp,revoked:false,shared:false};
        const projection:Projection={revision:1,source,records:{},metadata:{deviceId:input.sourceId},commands:{}};
        check(await store.replace(input.sourceId,null,projection),'This device was just paired elsewhere.',409);
        return reply({sourceId:input.sourceId,epoch,token:sign({purpose:'owner-paired-writer-v2',sourceId:input.sourceId,epoch,version:version(),exp:Date.now()+365*86400000})});
      }
      const sourceId=id.parse(url.searchParams.get('sourceId')??body.sourceId);
      if(action==='snapshot'&&method==='GET'){
        const projection=await store.get(sourceId);check(projection&&!projection.source.revoked,'Workspace not found.',404);
        check(projection!.source.ready,'The initial device upload is still in progress.',409,'INITIAL_UPLOAD_PENDING');
        return reply({source:projection!.source,records:Object.values(projection!.records)});
      }
      if(action==='bootstrap'&&method==='GET'){
        const index=(await store.list()).find(source=>source.sourceId===sourceId);
        check(index?.shared&&!index.revoked,'Enable shared POS for this workspace first.',409);
        if(Date.now()-new Date(index!.lastSeenAt).getTime()>30000)await store.touch(sourceId,now());
        if(url.searchParams.get('ifVersion')===String(index!.dataVersion??0))return reply({notModified:true,serverTime:now()});
        const projection=await store.get(sourceId);check(projection?.source.shared&&!projection.source.revoked,'Enable shared POS for this workspace first.',409);
        const data=await monitorBootstrap(projection!,url.searchParams);data.sync={...data.sync,configured:true,lastSync:projection!.source.updatedAt};return reply({...data,cloudVersion:projection!.source.dataVersion??0});
      }
      if(['revoke','promote','command'].includes(action)&&method==='POST'){
        for(let attempt=0;attempt<6;attempt++){
          const projection=await store.get(sourceId);check(projection&&!projection.source.revoked,'Workspace not found.',404);
          const next=structuredClone(projection!);let response:unknown={ok:true};
          if(action==='revoke')next.source.revoked=true;
          if(action==='promote'){check(next.source.ready,'Finish the initial upload first.',409);next.source.shared=true;}
          if(action==='command'){
            check(next.source.shared,'Enable shared POS before editing cloud records.',409);
            const input=z.object({sourceId:id,path:z.string().max(300),method:z.enum(['GET','POST','PUT','PATCH','DELETE']),body:z.record(z.string(),z.unknown()).optional()}).strict().parse(body);
            const commandId=input.body?.commandId;check(input.method==='GET'||typeof commandId==='string'&&commandId.length>=8&&commandId.length<=160,'A durable command ID is required.');
            const key=typeof commandId==='string'?recordKey('command',commandId):'';
            const digest=hash(stable(input));
            if(key&&next.commands?.[key]){check(next.commands[key].hash===digest,'Command ID was reused with different data.',409,'IDEMPOTENCY_CONFLICT');await store.publish(next.source);return reply(next.commands[key].response);}
            const path=new URL(input.path,'https://cloud.workspace');
            response=await monitorCommand(next,path.pathname,input.method,input.body??{},path.searchParams);
            if(input.method==='GET')return reply(response);
            next.commands??={};next.commands[key]={hash:digest,response};
          }
          next.source.updatedAt=now();next.source.lastSeenAt=now();next.revision++;
          next.source.dataVersion=(next.source.dataVersion??0)+1;
          if(await store.replace(sourceId,projection!.revision,next))return reply(response);
        }
        fail('Another device changed this workspace. Refresh and try again.',409,'CLOUD_BUSY');
      }
      return fail('Cloud action not found.',404,'NOT_FOUND');
    }catch(error){
      if(error instanceof z.ZodError)return reply({error:error.issues.map(issue=>issue.message).join('; '),code:'VALIDATION_ERROR'},400);
      const value=error as Error&{status?:number;code?:string};
      const status=value.status??500;
      return reply({error:status>=500?'The cloud database is unavailable. Local device data has not been deleted.':value.message,code:value.code??'CLOUD_ERROR'},status);
    }
  };
}
