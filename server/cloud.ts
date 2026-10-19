import Fastify from 'fastify';
import { firebaseDatabaseUrl } from './config';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getDatabase, type Database } from 'firebase-admin/database';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z, ZodError } from 'zod';
import { ApiError, now, requireThat, sha, stable } from './database';

const safeId=z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const kinds=['order','held','credit','inventory','movement','production','purchase','expense','shift','audit','refund','table','customer','supplier','staff','menu','recipe','category','branch','settings','media'] as const;
const globalKinds=new Set(['customer','supplier','staff','menu','recipe','category','settings','media']);
const eventSchema=z.object({id:safeId,commandId:safeId,branchId:safeId,sequence:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),action:z.string().min(1).max(160),actor:safeId,createdAt:z.iso.datetime(),changes:z.array(z.object({kind:z.enum(kinds),id:safeId,branchId:safeId.nullable(),value:z.record(z.string(),z.unknown())}).strict()).max(5000)}).strict();
export type CloudEvent=z.infer<typeof eventSchema>;
export interface HubCredential { branchId:string;token:string }
export interface CloudPersistence { apply(hubId:string,event:CloudEvent,hash:string):Promise<void> }
export interface CloudOptions { credentials?:Record<string,HubCredential>;persistence?:CloudPersistence;logger?:boolean }

function validateJson(value:unknown,depth=0):void {
  requireThat(depth<=12,'Event data exceeds the maximum nesting depth.');
  if(value===null||typeof value==='boolean')return;
  if(typeof value==='string'){requireThat(value.length<=20000,'An event field is too long.');return;}
  if(typeof value==='number'){requireThat(Number.isFinite(value)&&Math.abs(value)<=Number.MAX_SAFE_INTEGER,'An event contains an invalid number.');return;}
  if(Array.isArray(value)){requireThat(value.length<=1000,'An event array is too large.');value.forEach(x=>validateJson(x,depth+1));return;}
  requireThat(typeof value==='object'&&value!==null,'An event contains unsupported data.');
  const entries=Object.entries(value);requireThat(entries.length<=100,'An event object has too many fields.');
  for(const [key,child] of entries){requireThat(!/[.#$[\]/]/.test(key)&&!['__proto__','constructor','prototype','pin','password','salt','token'].includes(key),'An event contains a forbidden field.');validateJson(child,depth+1);}
}
function validateEvent(event:CloudEvent,credential:HubCredential) {
  requireThat(event.branchId===credential.branchId,'This hub is not authorized for this branch.',403,'BRANCH_FORBIDDEN');
  requireThat(Buffer.byteLength(stable(event))<=1024*1024,'An event exceeds the 1 MB size limit.',413);
  for(const change of event.changes) {
    requireThat(change.value.id===change.id||change.kind==='settings','A changed record has a mismatching ID.');
    if(change.kind==='branch')requireThat(change.branchId===event.branchId&&change.id===event.branchId,'Branch metadata must match the authorized branch.',403);
    else if(globalKinds.has(change.kind)) {
      requireThat(change.branchId===null||change.branchId===event.branchId,'A changed record belongs to another branch.',403);
      if(change.value.branchId!==undefined&&change.value.branchId!==null)requireThat(change.value.branchId===event.branchId,'A changed record belongs to another branch.',403);
    } else requireThat(change.branchId===event.branchId&&change.value.branchId===event.branchId,'A changed record belongs to another branch.',403);
    validateJson(change.value);
  }
}

/**
 * Immutable events are the recovery ledger; projection is a convenient current
 * view. A retry finishes a partially applied event before acknowledging it.
 * Each branch has exactly one authorized writer. No browser receives Admin SDK credentials.
 */
export function firebasePersistence(database:Database,tenantId:string):CloudPersistence {
  safeId.parse(tenantId);
  return {async apply(hubId,event,hash) {
    const branch=database.ref(`tenants/${tenantId}/branches/${event.branchId}`);
    const eventRef=branch.child(`events/${event.id}`);
    const receipt=await eventRef.transaction(current=>{
      if(current===null)return {hash,hubId,status:'received',receivedAt:now(),event};
      if(current.hash===hash&&current.hubId===hubId)return current;
      return undefined;
    },undefined,false);
    requireThat(receipt.committed,'An event ID was reused with different content.',409,'EVENT_CONFLICT');
    if(receipt.snapshot.val()?.status==='applied')return;
    // Sequence claims detect a hub restored from an old local snapshot attempting
    // to reuse already committed sequence numbers for new commands.
    const sequence=await branch.child(`sequences/${hubId}/${event.sequence}`).transaction(current=>{
      if(current===null)return {eventId:event.id,hash};
      return current.eventId===event.id&&current.hash===hash?current:undefined;
    },undefined,false);
    requireThat(sequence.committed,'This hub sequence was already used. Restore/reconnect requires reconciliation with the cloud ledger.',409,'SEQUENCE_CONFLICT');
    const projected=await branch.child('projection').transaction(current=>{
      const value=current??{};
      if(value.authorityHubId&&value.authorityHubId!==hubId)return undefined;
      value.authorityHubId=hubId;value.records??={};
      for(const change of event.changes) {
        value.records[change.kind]??={};
        const existing=value.records[change.kind][change.id];
        // A delayed retry must never overwrite a newer branch record.
        if(!existing||existing.sequence<event.sequence||existing.eventId===event.id)value.records[change.kind][change.id]={value:change.value,sequence:event.sequence,eventId:event.id};
      }
      value.lastSequence=Math.max(value.lastSequence??0,event.sequence);value.updatedAt=now();
      return value;
    },undefined,false);
    requireThat(projected.committed,'This branch projection belongs to another hub. An operator must authorize a hub transfer.',409,'HUB_AUTHORITY_CONFLICT');
    await eventRef.update({status:'applied',appliedAt:now()});
  }};
}

export async function createCloudApp(options:CloudOptions={}) {
  const credentials=z.record(safeId,z.object({branchId:safeId,token:z.string().min(32).max(512)}).strict()).parse(options.credentials??JSON.parse(process.env.CLOUD_HUB_CREDENTIALS??'{}'));
  requireThat(Object.keys(credentials).length>0,'Configure at least one branch credential in CLOUD_HUB_CREDENTIALS.',500);
  const branches=Object.values(credentials).map(x=>x.branchId);requireThat(new Set(branches).size===branches.length,'Configure exactly one active hub credential per branch.',500);
  let persistence=options.persistence;
  if(!persistence) {
    const databaseURL=firebaseDatabaseUrl();
    requireThat(databaseURL,'FIREBASE_DATABASE_URL is required by the cloud receiver.',500);
    const admin=getApps().find(x=>x.name==='demo-hotel-cloud')??initializeApp({credential:applicationDefault(),databaseURL},'demo-hotel-cloud');
    persistence=firebasePersistence(getDatabase(admin),process.env.CLOUD_TENANT_ID??'demo-hotel');
  }
  const app=Fastify({logger:options.logger??false,bodyLimit:8*1024*1024,trustProxy:false});
  const invalidAuth=new Map<string,{count:number;expires:number}>();
  app.addHook('onRequest',async(request,reply)=>{reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff');if(request.method!=='GET'){const attempt=invalidAuth.get(request.ip);requireThat(!attempt||attempt.count<30||attempt.expires<Date.now(),'Too many invalid authentication attempts.',429);}});
  app.setErrorHandler((error,request,reply)=>{
    if(error instanceof ZodError)return reply.code(400).send({error:'The sync event payload is invalid.',code:'VALIDATION_ERROR'});
    if(error instanceof ApiError)return reply.code(error.statusCode).send({error:error.message,code:error.code});
    request.log.error(error);return reply.code(500).send({error:'Events were not acknowledged. Retry after the receiver recovers.',code:'PERSISTENCE_ERROR'});
  });
  app.get('/api/health',async()=>({ok:true,service:'demo-hotel-cloud-receiver',time:now()}));
  app.post('/api/ingest',async request=>{
    const body=z.object({hubId:safeId,events:z.array(eventSchema).min(1).max(50)}).strict().parse(request.body);
    const credential=credentials[body.hubId];const provided=request.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1]??'';
    const valid=credential&&timingSafeEqual(Buffer.from(sha(provided),'hex'),Buffer.from(sha(credential.token),'hex'));
    if(!valid){const previous=invalidAuth.get(request.ip);const attempt=previous&&previous.expires>Date.now()?previous:{count:0,expires:Date.now()+15*60000};attempt.count++;if(invalidAuth.size>1000)invalidAuth.clear();invalidAuth.set(request.ip,attempt);throw new ApiError(401,'The hub credentials are invalid.','INVALID_CREDENTIALS');}
    body.events.forEach(event=>validateEvent(event,credential));
    requireThat(new Set(body.events.map(x=>x.id)).size===body.events.length,'Duplicate event IDs are not allowed in one batch.');
    const acceptedIds:string[]=[];
    for(const event of body.events.toSorted((a,b)=>a.sequence-b.sequence)){await persistence!.apply(body.hubId,event,sha(stable(event)));acceptedIds.push(event.id);}
    return {acceptedIds};
  });
  return app;
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])) {
  const app=await createCloudApp({logger:true});
  const close=async()=>{await app.close();process.exit(0);};process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
  await app.listen({host:process.env.CLOUD_HOST??'0.0.0.0',port:Number(process.env.CLOUD_PORT??3002)});
}
