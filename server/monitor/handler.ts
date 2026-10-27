import {createHash,createHmac,randomUUID,scryptSync,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {CLOUD_MONITOR_KINDS,CLOUD_MONITOR_MAX_BYTES,type CloudSource,type CloudChange} from '../../shared/cloud-monitor.js';
import {firebaseMonitorStore,recordKey,type MonitorStore,type Projection} from './store.js';
import {monitorBootstrap,monitorCommand} from './engine.js';
import {applyOfflineCommit,offlineCloudState,offlineCommitSchema} from './offline.js';
import {assertMediaPayload,isMediaId,type MediaRecord} from '../../shared/media.js';

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
  const posSessionSeconds=365*86400;
  const scryptFormat=/^scrypt\$[a-fA-F0-9]{64}\$[a-fA-F0-9]{128}$/;
  const pinFormat=/^[0-9]{6,16}$/;
  const posPinConfigured=()=>env.CLOUD_POS_PIN_HASH?scryptFormat.test(env.CLOUD_POS_PIN_HASH):pinFormat.test(env.CLOUD_POS_PIN??'');
  const ownerLoginConfigured=()=>Boolean(env.CLOUD_OWNER_EMAIL&&(env.CLOUD_OWNER_PASSWORD_HASH||env.CLOUD_OWNER_PASSWORD));
  const missing=()=>[
    !posPinConfigured()&&!ownerLoginConfigured()&&'CLOUD_POS_PIN_HASH',
    (!env.CLOUD_SESSION_SECRET||env.CLOUD_SESSION_SECRET.length<32)&&'CLOUD_SESSION_SECRET',
    !options.store&&!env.FIREBASE_DATABASE_URL&&'FIREBASE_DATABASE_URL',
    !options.store&&!env.FIREBASE_SERVICE_ACCOUNT_JSON&&'FIREBASE_SERVICE_ACCOUNT_JSON',
  ].filter(Boolean) as string[];
  // Rotating either login credential also revokes existing sessions and device grants.
  const version=()=>hash(`${env.CLOUD_OWNER_EMAIL}:${env.CLOUD_OWNER_PASSWORD_HASH??env.CLOUD_OWNER_PASSWORD}:${env.CLOUD_POS_PIN_HASH??env.CLOUD_POS_PIN}`);
  const sign=(payload:Record<string,unknown>)=>{
    const text=Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${text}.${createHmac('sha256',env.CLOUD_SESSION_SECRET!).update(text).digest('base64url')}`;
  };
  const verify=(token:string,purpose:string):Record<string,any>|null=>{
    try{const [text,signature,...rest]=token.split('.');if(rest.length||!text||!signature||!constant(signature,createHmac('sha256',env.CLOUD_SESSION_SECRET!).update(text).digest('base64url')))return null;
      const value=JSON.parse(Buffer.from(text,'base64url').toString());return value.purpose===purpose&&typeof value.exp==='number'&&Number.isFinite(value.exp)&&value.exp>Date.now()&&value.version===version()?value:null;
    }catch{return null;}
  };
  const authentication=(request:Request)=>{
    const cookie=request.headers.get('cookie')?.split(';').map(part=>part.trim()).find(part=>part.startsWith('hotel-cloud='))?.slice(12)??'';
    return verify(cookie,'owner')||(posPinConfigured()?verify(cookie,'pos-owner-v1'):null);
  };
  const owner=(request:Request)=>{const session=authentication(request);check(session,'Sign in to your POS.',401,'UNAUTHENTICATED');return session!;};
  const scryptValid=(input:string,encoded:string)=>{
    try{if(!scryptFormat.test(encoded))return false;const [,salt,digest]=encoded.split('$');return constant(scryptSync(input,Buffer.from(salt,'hex'),64).toString('hex'),digest.toLowerCase());}catch{return false;}
  };
  const passwordValid=(password:string)=>{
    if(env.CLOUD_OWNER_PASSWORD_HASH)return scryptValid(password,env.CLOUD_OWNER_PASSWORD_HASH);
    return Boolean(env.CLOUD_OWNER_PASSWORD&&env.CLOUD_OWNER_PASSWORD.length>=12&&constant(password,env.CLOUD_OWNER_PASSWORD));
  };
  const pinValid=(pin:string)=>pinFormat.test(pin)&&(env.CLOUD_POS_PIN_HASH?scryptValid(pin,env.CLOUD_POS_PIN_HASH):Boolean(env.CLOUD_POS_PIN&&constant(pin,env.CLOUD_POS_PIN)));
  return async(request:Request):Promise<Response>=>{
    const headers:Record<string,string>={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
    const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers});
    try{
      const url=new URL(request.url),action=url.searchParams.get('action')??'status',method=request.method.toUpperCase();
      const rememberPos=()=>{
        const expires=Date.now()+posSessionSeconds*1000;
        headers['Set-Cookie']=`hotel-cloud=${sign({purpose:'pos-owner-v1',version:version(),exp:expires})}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${posSessionSeconds}; Expires=${new Date(expires).toUTCString()}${url.protocol==='https:'?'; Secure':''}`;
      };
      const renewPos=(session:Record<string,any>|null)=>{
        // Refresh at most daily, including upgrading still-valid 12-hour POS
        // cookies, without rewriting the cookie on every background poll.
        if(session?.purpose==='pos-owner-v1'&&session.exp<=Date.now()+(posSessionSeconds-86400)*1000)rememberPos();
      };
      if(action==='status'&&method==='GET')return reply({configured:missing().length===0,missing:missing(),posPinConfigured:posPinConfigured()});
      if(missing().length)return reply({error:'Cloud monitoring is not configured on this server.',code:'CLOUD_NOT_CONFIGURED',missing:missing()},503);
      check(/^[A-Za-z0-9_-]{1,80}$/.test(env.CLOUD_TENANT_ID??'hotel'),'Invalid cloud tenant configuration.',503);
      const store=options.store??firebaseMonitorStore(env);
      const mutating=method!=='GET';
      if(mutating){check(request.headers.get('content-type')?.split(';')[0]==='application/json','Send JSON data.',415);}
      if(mutating&&!['push','heartbeat'].includes(action))check(request.headers.get('origin')===url.origin,'This request must come from the same site.',403,'INVALID_ORIGIN');
      let body:any={};
      if(mutating){const text=await request.text();check(Buffer.byteLength(text)<=CLOUD_MONITOR_MAX_BYTES,'Cloud packet exceeds 700 KB.',413);try{body=JSON.parse(text);}catch{fail('Invalid JSON request.');}check(body&&typeof body==='object'&&!Array.isArray(body),'Invalid request body.');}
      if(action==='pos-login'&&method==='POST'){
        check(posPinConfigured(),'POS PIN sign-in is not configured on this server.',503,'POS_PIN_NOT_CONFIGURED');
        const input=z.object({pin:z.string().max(64)}).strict().parse(body);
        const ip=hash(request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()??'local');
        check(await store.rate('pos-login-global',150,15*60000),'Too many PIN attempts. Try again later.',429,'RATE_LIMITED');
        check(await store.rate(`pos-login-${ip}`,12,15*60000),'Too many PIN attempts. Try again later.',429,'RATE_LIMITED');
        check(pinValid(input.pin),'The POS PIN is incorrect.',401,'INVALID_CREDENTIALS');
        rememberPos();
        return reply({ok:true});
      }
      if(action==='login'&&method==='POST'){
        check(ownerLoginConfigured(),'Owner account sign-in is not configured on this server.',503,'OWNER_LOGIN_NOT_CONFIGURED');
        const input=z.object({email:z.string().max(254),password:z.string().max(512)}).strict().parse(body);
        const ip=hash(request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()??'local');
        check(await store.rate('login-global',150,15*60000),'Too many sign-in attempts. Try again later.',429,'RATE_LIMITED');
        check(await store.rate(`login-${ip}`,12,15*60000),'Too many sign-in attempts. Try again later.',429,'RATE_LIMITED');
        check(constant(input.email.trim().toLowerCase(),env.CLOUD_OWNER_EMAIL!.trim().toLowerCase())&&passwordValid(input.password),'Cloud email or password is incorrect.',401,'INVALID_CREDENTIALS');
        headers['Set-Cookie']=`hotel-cloud=${sign({purpose:'owner',version:version(),exp:Date.now()+12*3600000})}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${url.protocol==='https:'?'; Secure':''}`;
        return reply({ok:true});
      }
      if(['session','pos-session'].includes(action)&&method==='GET'){
        const session=authentication(request);
        renewPos(session);
        return reply({authenticated:Boolean(session)});
      }
      if(['logout','pos-logout'].includes(action)&&method==='POST'){headers['Set-Cookie']=`hotel-cloud=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${url.protocol==='https:'?'; Secure':''}`;return reply({ok:true});}
      if(['push','heartbeat'].includes(action)&&method==='POST'){
        const bearer=request.headers.get('authorization')?.replace(/^Bearer /,'')??'';
        // Earlier writer purposes were issued by an unsafe anonymous endpoint.
        // Rotating the purpose revokes those capabilities without removing data.
        const token=verify(bearer,'owner-paired-writer-v3');
        check(!verify(bearer,'writer')&&!verify(bearer,'owner-paired-writer-v2'),'This device uses an older cloud connection. Reconnect by signing in to your POS at the normal app address. Pending local changes have not been deleted.',401,'DEVICE_RECONNECT_REQUIRED');
        check(token,'The device connection has expired. Sign in to your POS at the normal app address.',401,'INVALID_DEVICE');
        const sourceId=id.parse(body.sourceId),epoch=id.parse(body.epoch);
        check(token!.sourceId===sourceId&&token!.epoch===epoch,'Device connection does not match this workspace.',403);
        if(action==='heartbeat'){
          const source=(await store.list()).find(source=>source.sourceId===sourceId);
          check(source&&!source.revoked&&source.epoch===epoch,'This device connection was revoked.',401,'DEVICE_REVOKED');
          const timestamp=now();await store.touch(sourceId,timestamp);return reply({lastSeenAt:timestamp,shared:Boolean(source?.shared)});
        }
        const input=action==='push'?push.parse(body):null;
        if(input)for(const row of input.changes){check(row.kind!=='media','Product photo uploads require authenticated shared POS.',403,'SHARED_MEDIA_REQUIRED');check(row.value.id===row.id||row.kind==='settings','Cloud record ID mismatch.');validateData(row.value);}
        for(let attempt=0;attempt<6;attempt++){
          const projection=await store.get(sourceId);
          check(projection&&!projection.source.revoked&&projection.source.epoch===epoch,'This device connection was revoked.',401,'DEVICE_REVOKED');
          check(!projection!.source.shared,'This workspace now uses shared POS. Open its shared POS link to continue. Independent device records have not been uploaded or deleted.',409,'SHARED_WORKSPACE');
          const next=structuredClone(projection!);
          if(input){
            const digest=hash(stable(input));
            if(next.lastEvent?.id===input.eventId){
              check(next.lastEvent?.hash===digest,'Packet replay differs from the saved packet.',409,'SEQUENCE_CONFLICT');
              await store.publish(next.source);
              return reply({sequence:input.sequence,updatedAt:next.source.updatedAt});
            }
            check(input.sequence===next.source.sequence+1,'A cloud packet is missing or its sequence was already used. Retry the saved pending packet.',409,'SEQUENCE_CONFLICT');
            for(const row of input.changes){
              const key=recordKey(row.kind,row.id);
              if(row.value.deleted===true)delete next.records[key];
              else next.records[key]=row;
              if(row.kind==='settings')next.metadata.settings=row.value;
            }
            next.source.sequence=input.sequence;
            next.source.ready=next.source.ready||input.ready;
            next.source.updatedAt=now();
            next.source.dataVersion=(next.source.dataVersion??0)+1;
            next.lastEvent={id:input.eventId,hash:digest};
          }
          next.source.lastSeenAt=now();next.revision++;
          if(await store.replace(sourceId,projection!.revision,next))return reply(input?{sequence:input.sequence,updatedAt:next.source.updatedAt}:{lastSeenAt:next.source.lastSeenAt});
        }
        fail('Another device changed this workspace. Refresh and try again.',409,'CLOUD_BUSY');
      }
      const session=owner(request);
      // Active trusted browsers keep their POS access; only a verified, current
      // PIN session can renew. Legacy owner sessions retain their 12-hour limit.
      renewPos(session);
      if(action==='workspace'&&method==='POST'){
        const input=z.object({create:z.boolean().default(false)}).strict().parse(body);
        // An old heartbeat could leave an unindexed main-store shell with no
        // enrollment identity or business data. It is not an unfinished import.
        const emptyLegacyShell=(value:Projection)=>value.source.sourceId==='main-store'&&!value.source.workspaceId&&!value.source.epoch&&!value.source.revoked&&!value.metadata.settings&&Object.keys(value.records).length===0&&Object.keys(value.commands??{}).length===0;
        for(let attempt=0;attempt<6;attempt++){
          const listed=await store.list(),canonical=await store.get('main-store');
          if(canonical&&!listed.some(source=>source.sourceId==='main-store'))listed.push(canonical.source);
          const projections=(await Promise.all(listed.filter(source=>!source.revoked).map(source=>store.get(source.sourceId)))).filter((value):value is Projection=>Boolean(value&&!value.source.revoked&&!emptyLegacyShell(value)));
          const usable=projections.filter(value=>value.source.ready&&value.metadata.settings&&Object.values(value.records).some(row=>row.kind==='branch'));
          const shared=usable.filter(value=>value.source.shared);
          if(shared.length===1){await store.publish(shared[0].source);return reply({sourceId:shared[0].source.sourceId});}
          if(shared.length>1||usable.length>1)return reply({sourceId:null,selectionRequired:true});
          if(usable.length===1){
            const existing=usable[0],next=structuredClone(existing);next.source.shared=true;next.source.dataVersion=(next.source.dataVersion??0)+1;next.source.updatedAt=now();next.source.lastSeenAt=now();next.revision++;
            if(await store.replace(next.source.sourceId,existing.revision,next))return reply({sourceId:next.source.sourceId});
            continue;
          }
          if(projections.some(value=>!value.source.ready||Object.keys(value.records).length>0))return reply({sourceId:null,selectionRequired:true});
          if(!input.create)return reply({sourceId:null,empty:true});
          // Initialize an empty cloud business only; never replace existing records.
          if(canonical?.source.revoked)return fail('The primary workspace was revoked. Select an authorized workspace.',409);
          const timestamp=now(),sourceId='main-store';
          const settings={businessName:'DEMO HOTEL',tagline:'Restaurant & kitchen',currency:'LKR',taxRate:0,serviceChargeRate:0,receiptFooter:'Thank you for your order.',lowStockAlerts:true,autoPrint:false,language:'en',receiptPaperWidthMm:80,receiptContentWidthMm:72,receiptMarginMm:2,receiptOffsetMm:0,receiptFontSize:10};
          const rows:CloudChange[]=[
            {kind:'branch',id:'b1',branchId:null,value:{id:'b1',name:'Main branch',nameSi:'Main branch',code:'MAIN',address:'',phone:''}},
            {kind:'settings',id:'settings',branchId:null,value:settings},
            {kind:'category',id:'general',branchId:null,value:{id:'general',name:'General',nameSi:'General',icon:'grid'}},
            {kind:'staff',id:'cloud-owner',branchId:null,value:{id:'cloud-owner',name:'Cloud owner',initials:'CO',role:'owner',branchId:null,active:true,phone:'',lastActive:timestamp}},
          ];
          const source:CloudSource={sourceId,workspaceId:canonical?.source.workspaceId??`workspace-${randomUUID()}`,businessName:settings.businessName,deviceName:'Shared workspace',epoch:canonical?.source.epoch??randomUUID(),sequence:canonical?.source.sequence??0,ready:true,shared:true,revoked:false,updatedAt:timestamp,lastSeenAt:timestamp,dataVersion:(canonical?.source.dataVersion??0)+1};
          const next:Projection={revision:(canonical?.revision??0)+1,source,records:Object.fromEntries(rows.map(row=>[recordKey(row.kind,row.id),row])),metadata:{settings,deviceId:sourceId,activeBranchId:'b1'},commands:{}};
          if(await store.replace(sourceId,canonical?.revision??null,next))return reply({sourceId});
        }
        return fail('Another device is preparing the shared workspace. Retry in a moment.',409,'CLOUD_BUSY');
      }
      if(action==='auto-enroll'&&method==='POST')return fail('Anonymous device enrollment is disabled. Sign in with the owner account at the normal app address to open the shared workspace.',410,'AUTO_ENROLL_DISABLED');
      if(action==='active-source'&&method==='GET'){
        // Discovery must never create a source or guess an independent local copy.
        const candidates=(await store.list()).filter(source=>!source.revoked&&source.shared&&source.ready);
        const usable:CloudSource[]=[];
        for(const source of candidates){
          const projection=await store.get(source.sourceId);
          if(projection?.source.shared&&projection.source.ready&&!projection.source.revoked&&projection.metadata.settings&&Object.values(projection.records).some(row=>row.kind==='branch'))usable.push(projection.source);
        }
        return reply({sourceId:usable.length===1?usable[0].sourceId:null,shared:usable.length===1,selectionRequired:usable.length>1});
      }
      if(action==='sources'&&method==='GET')return reply({sources:(await store.list()).filter(source=>!source.revoked)});
      if(action==='refresh-device'&&method==='POST'){
        const input=z.object({sourceId:id,workspaceId:id}).strict().parse(body);
        const projection=await store.get(input.sourceId);
        check(projection&&!projection.source.revoked,'The original device connection is unavailable.',404,'DEVICE_NOT_FOUND');
        check(projection!.source.workspaceId===input.workspaceId,'This device does not match the saved business.',403,'WORKSPACE_MISMATCH');
        check(!projection!.source.shared,'This business already uses shared POS. Open the normal app address to continue.',409,'SHARED_WORKSPACE');
        // Re-authentication can renew a rotated credential version without
        // creating another source, resetting its journal position or replacing data.
        return reply({sourceId:projection!.source.sourceId,epoch:projection!.source.epoch,token:sign({purpose:'owner-paired-writer-v3',sourceId:projection!.source.sourceId,epoch:projection!.source.epoch,version:version(),exp:Date.now()+365*86400000})});
      }
      if(action==='enroll'&&method==='POST'){
        const input=z.object({sourceId:id,businessName:z.string().trim().min(2).max(100),deviceName:z.string().trim().min(2).max(100),workspaceId:id}).strict().parse(body);
        check(!await store.get(input.sourceId),'This device is already linked. Revoke its old connection before pairing with a new source ID.',409,'ALREADY_LINKED');
        const epoch=randomUUID(),timestamp=now();
        const source:CloudSource={...input,epoch,sequence:0,ready:false,updatedAt:timestamp,lastSeenAt:timestamp,revoked:false,shared:false};
        const projection:Projection={revision:1,source,records:{},metadata:{deviceId:input.sourceId},commands:{}};
        check(await store.replace(input.sourceId,null,projection),'This device was just paired elsewhere.',409);
        return reply({sourceId:input.sourceId,epoch,token:sign({purpose:'owner-paired-writer-v3',sourceId:input.sourceId,epoch,version:version(),exp:Date.now()+365*86400000})});
      }
      const sourceId=id.parse(url.searchParams.get('sourceId')??body.sourceId);
      if(action==='media'&&method==='GET'){
        const photoId=url.searchParams.get('id');check(isMediaId(photoId),'Photo not found.',404,'PHOTO_NOT_FOUND');
        const projection=await store.get(sourceId);
        check(projection?.source.shared&&projection.source.ready&&!projection.source.revoked,'Workspace not found.',404);
        check(store.getMedia,'Cloud product photos are unavailable on this server.',503);
        const media=await store.getMedia!(sourceId,photoId!);check(media,'Photo not found.',404,'PHOTO_NOT_FOUND');
        assertMediaPayload(media);return reply({media});
      }
      if(action==='snapshot'&&method==='GET'){
        const projection=await store.get(sourceId);check(projection&&!projection.source.revoked,'Workspace not found.',404);
        check(projection!.source.ready,'The initial device upload is still in progress.',409,'INITIAL_UPLOAD_PENDING');
        return reply({source:projection!.source,records:Object.values(projection!.records),settings:projection!.metadata.settings??null,dataVersion:projection!.source.dataVersion??0});
      }
      if(action==='bootstrap'&&method==='GET'){
        const index=(await store.list()).find(source=>source.sourceId===sourceId);
        check(index?.shared&&!index.revoked&&index.ready,'Enable shared POS for this workspace after its initial upload completes.',409);
        if(Date.now()-new Date(index!.lastSeenAt).getTime()>30000)await store.touch(sourceId,now());
        if(url.searchParams.get('ifVersion')===String(index!.dataVersion??0))return reply({notModified:true,serverTime:now()});
        const projection=await store.get(sourceId);check(projection?.source.shared&&!projection.source.revoked&&projection.source.ready,'Enable shared POS for this workspace after its initial upload completes.',409);
        const data=await monitorBootstrap(projection!,url.searchParams);data.sync={...data.sync,configured:true,lastSync:projection!.source.updatedAt};return reply({...data,cloudVersion:projection!.source.dataVersion??0,...(url.searchParams.get('includeOffline')==='1'?{offlineState:offlineCloudState(projection!)}:{})});
      }
      if(action==='offline-commit'&&method==='POST'){
        const input=offlineCommitSchema.parse(body);
        for(const effect of input.changes){if(effect.before)validateData(effect.before);if(effect.after)validateData(effect.after);}
        // A transport failure may upgrade an unacknowledged online command to
        // offline-completed. The immutable effects still identify one receipt.
        const {offline:_offline,...identity}=input;
        const key=recordKey('offline-command',JSON.stringify([input.deviceId,input.transactionId])),digest=hash(stable(identity));
        const savedPhotos=new Set<string>();
        for(let attempt=0;attempt<6;attempt++){
          const projection=await store.get(sourceId);
          check(projection?.source.shared&&projection.source.ready&&!projection.source.revoked,'The shared workspace is unavailable. The transaction remains saved on this device.',409,'WORKSPACE_UNAVAILABLE');
          const prior=projection!.commands?.[key];
          if(prior){
            check(prior.hash===digest,'The offline transaction ID was reused with different data.',409,'IDEMPOTENCY_CONFLICT');
            await store.publish(projection!.source);return reply(prior.response);
          }
          const next=structuredClone(projection!),result=applyOfflineCommit(next,input);
          for(const effect of input.changes.filter(value=>value.kind==='media'&&value.after&&!savedPhotos.has(value.id))){
            check(store.putMedia,'Cloud product photos are unavailable on this server.',503);
            const photo=assertMediaPayload(effect.after),record:MediaRecord={...photo,branchId:null,createdAt:typeof effect.after!.createdAt==='string'?effect.after!.createdAt:input.createdAt};
            check(await store.putMedia!(sourceId,record),'This photo ID already belongs to a different image.',409,'PHOTO_CONFLICT');
            savedPhotos.add(effect.id);
          }
          next.source.updatedAt=now();next.source.lastSeenAt=now();next.revision++;
          next.source.dataVersion=(next.source.dataVersion??0)+1;
          const response={...result,cloudVersion:next.source.dataVersion};
          next.commands??={};next.commands[key]={hash:digest,response};
          if(await store.replace(sourceId,projection!.revision,next))return reply(response);
        }
        return fail('Another device is syncing transactions. Your saved transaction will retry.',409,'CLOUD_BUSY');
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
      const value=(error instanceof Error?error:new Error('Unknown cloud failure.')) as Error&{status?:number;code?:string};
      const reportedStatus=value.status??500;
      const status=Number.isInteger(reportedStatus)&&reportedStatus>=400&&reportedStatus<=599?reportedStatus:500;
      return reply({
        error:status>=500?'The cloud database is unavailable. Local device data has not been deleted.':value.message,
        code:status>=500?'CLOUD_ERROR':value.code??'CLOUD_ERROR'
      },status);
    }
  };
}
