import 'fake-indexeddb/auto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Order,Snapshot,StaffMember} from '../shared/types';
import {browserDb,type Draft} from '../src/lib/db';
import {LocalDatabase,LocalStore} from '../src/lib/local/db';
import {createLocalApi,initializeLocalWorkspace} from '../src/lib/local/core';
import {forgetLocalSession,getLocalUser,loginLocal} from '../src/lib/local/auth';
import {buildBackupPayload,recoverRestoredDrafts,restoreDeviceBackup,validateDeviceBackupPayload,type BackupPayload} from '../src/lib/local/backup';
import {decryptDeviceBackup,encryptDeviceBackup} from '../src/lib/local/backup-crypto';

const pin='9876543210',password='private backup passphrase';
const commandId=()=>crypto.randomUUID();
const ownerName='Backup Test Owner';
async function fixture(demo=true){
  await browserDb.drafts.clear();
  const db=new LocalDatabase(`local-backup-${commandId()}`);
  await initializeLocalWorkspace({businessName:'Backup Restaurant',ownerName,pin,demo},db);
  return{db,api:createLocalApi(db),store:new LocalStore(db)};
}
async function destroy(db:LocalDatabase){forgetLocalSession(db);await db.delete();await browserDb.drafts.clear();}
function sampleDraft(id='device:b1'):Draft{return{id,lines:[{menuItemId:'m1',quantity:2,note:'Less salt'}],type:'takeaway',tableId:'',customerId:'c1',heldBillId:'',heldBillUpdatedAt:'',note:'Keep separate',discount:0,commandId:commandId(),updatedAt:new Date().toISOString()};}
async function contents(db:LocalDatabase){return db.transaction('r',db.tables,async()=>({records:await db.records.toArray(),metadata:await db.metadata.toArray(),credentials:await db.credentials.toArray(),sessions:await db.sessions.toArray(),commands:await db.commands.toArray(),journal:await db.journal.toArray()}));}
const meta=(payload:BackupPayload,key:string)=>payload.tables.metadata.find(item=>item.key===key)!;
const clone=(payload:BackupPayload)=>structuredClone(payload);

test('real owner data encrypts, validates and restores with refunds, images, journal and a new device identity',async()=>{
  const {db,api,store}=await fixture();
  try{
    let order=(await api<{order:Order}>('/orders',{commandId:commandId(),branchId:'b1',type:'takeaway',customerId:'c1',lines:[{menuItemId:'m1',quantity:1}]})).order;
    order=(await api<{order:Order}>(`/orders/${order.id}/payments`,{commandId:commandId(),expectedVersion:order.version,method:'cash',amount:order.total,received:order.total})).order;
    await api(`/orders/${order.id}/refunds`,{commandId:commandId(),expectedVersion:order.version,method:'cash',amount:1000,reason:'Test partial refund'});
    const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jTMsAAAAASUVORK5CYII=';
    await store.put('media',{id:'media-backup-photo01',branchId:null,mime:'image/png',data:image,byteLength:Buffer.from(image,'base64').length,width:1,height:1,createdAt:new Date().toISOString()});
    const product=await store.get<any>('menu','m1');await store.put('menu',{...product,image:'local-image:media-backup-photo01'});
    await db.metadata.put({key:'photo-uploaded:https://old-device.test:media-backup-photo01',value:{uploadedAt:new Date().toISOString()}});
    const draft=sampleDraft();await browserDb.drafts.put(draft);
    const payload=await buildBackupPayload(db);
    assert.ok(payload.tables.records.some(item=>item.kind==='refund'));
    assert.ok(payload.tables.records.some(item=>item.kind==='media'));
    assert.equal('sessions'in payload.tables,false);
    const encrypted=await encryptDeviceBackup(payload,password);
    assert.equal(encrypted.includes(ownerName),false);
    const verified=validateDeviceBackupPayload(await decryptDeviceBackup(encrypted,password));
    assert.deepEqual(verified,payload);
    const before=await api<Snapshot>('/bootstrap');
    const workspaceBefore=meta(verified,'workspace').value as {workspaceId:string;deviceId:string};
    await api('/expenses',{commandId:commandId(),branchId:'b1',category:'Other',description:'Remove after restore',amount:100,paymentMethod:'cash'});
    assert.deepEqual(await restoreDeviceBackup(verified,db),{draftRecoveryPending:false});
    assert.equal(await db.sessions.count(),0);assert.equal(await getLocalUser(db),null);
    const restored=(await db.metadata.get('workspace'))!.value as {workspaceId:string;deviceId:string};
    assert.equal(restored.workspaceId,workspaceBefore.workspaceId);assert.notEqual(restored.deviceId,workspaceBefore.deviceId);
    assert.equal((await db.metadata.get('deviceId'))!.value,restored.deviceId);
    assert.equal((await db.metadata.get('restoredFromDeviceId'))!.value,workspaceBefore.deviceId);
    assert.equal(await db.metadata.get('photo-uploaded:https://old-device.test:media-backup-photo01'),undefined);
    await loginLocal(pin,undefined,db);
    const after=await api<Snapshot>('/bootstrap');
    for(const key of ['orders','inventory','expenses','customers','shifts'] as const)assert.deepEqual(after[key],before[key]);
    assert.deepEqual(await db.commands.toArray(),payload.tables.commands);
    assert.deepEqual(await db.journal.toArray(),payload.tables.journal);
    assert.deepEqual(await browserDb.drafts.get('device:b1'),draft);
    const next=(await api<{order:Order}>('/orders',{commandId:commandId(),branchId:'b1',type:'takeaway',lines:[{menuItemId:'m1',quantity:1}]})).order;
    assert.notEqual(next.number,order.number);
  }finally{await destroy(db);}
});

test('wrong passwords, tampering and truncated files never mutate existing business data',async()=>{
  const {db}=await fixture();
  try{
    const value=await buildBackupPayload(db),before=await contents(db);
    const encrypted=await encryptDeviceBackup(value,password);
    await assert.rejects(decryptDeviceBackup(encrypted,'incorrect password'),/password|damaged/i);
    const damaged=JSON.parse(encrypted);damaged.data=(damaged.data[0]==='A'?'B':'A')+damaged.data.slice(1);
    await assert.rejects(decryptDeviceBackup(JSON.stringify(damaged),password),/password|damaged/i);
    await assert.rejects(decryptDeviceBackup(encrypted.slice(0,-20),password),/valid device backup/i);
    const header=JSON.parse(encrypted);header.createdAt='2020-01-01T00:00:00.000Z';
    await assert.rejects(decryptDeviceBackup(JSON.stringify(header),password),/password|damaged/i);
    assert.deepEqual(await contents(db),before);
  }finally{await destroy(db);}
});

test('credential encodings, essential records, settings, schema and duplicate IDs are rejected before restore',async()=>{
  const {db,api}=await fixture();
  try{
    await api('/orders',{commandId:commandId(),branchId:'b1',type:'takeaway',lines:[{menuItemId:'m1',quantity:1}]});
    const original=await buildBackupPayload(db),before=await contents(db);
    const invalid:Array<(payload:BackupPayload)=>void>=[
      value=>{value.tables.credentials[0].salt='z'.repeat(64);},
      value=>{value.tables.credentials[0].hash='a'.repeat(63);},
      value=>{value.tables.credentials[0].iterations=2000001;},
      value=>{value.tables.credentials[0].iterations=99999;},
      value=>{value.tables.credentials[0].staffId='missing';},
      value=>{value.tables.records.push(value.tables.records[0]);},
      value=>{value.tables.metadata.push(value.tables.metadata[0]);},
      value=>{value.tables.commands.push(value.tables.commands[0]);},
      value=>{value.tables.journal.push({...value.tables.journal[0],id:'different-id'});},
      value=>{value.tables.records[0].value.id='different-id';},
      value=>{value.tables.records.find(item=>item.kind==='table')!.branchId='missing';},
      value=>{const row=value.tables.records.find(item=>item.kind==='table')!;row.branchId='missing';row.value.branchId='missing';},
      value=>{delete value.tables.records.find(item=>item.kind==='menu')!.value.name;},
      value=>{(meta(value,'settings').value as any).receiptContentWidthMm=120;},
      value=>{(meta(value,'settings').value as any).receiptOffsetMm=30;},
      value=>{(meta(value,'settings').value as any).taxRate=Infinity;},
      value=>{(meta(value,'workspace').value as any).version=2;},
      value=>{meta(value,'storageFormat').value=2;},
      value=>{meta(value,'journalSequence').value=0;},
      value=>{meta(value,'journalSequence').value=Number.MAX_SAFE_INTEGER+1;},
      value=>{value.tables.journal[0].sequence=Number.MAX_SAFE_INTEGER+1;},
      value=>{value.tables.journal[0].actor='missing-staff';},
      value=>{value.tables.records.find(item=>item.kind==='order')!.value.createdBy='missing-staff';},
      value=>{(value.tables as any).sessions=[];},
    ];
    for(const mutate of invalid){const value=clone(original);mutate(value);assert.throws(()=>validateDeviceBackupPayload(value));await assert.rejects(restoreDeviceBackup(value,db));}
    assert.deepEqual(await contents(db),before);
    const allowed=clone(original);allowed.tables.credentials[0].iterations=2000000;
    assert.equal(validateDeviceBackupPayload(allowed).tables.credentials[0].iterations,2000000);
  }finally{await destroy(db);}
});

test('quota failure after database clears rolls back all original tables and keeps the current owner signed in',async()=>{
  const {db,api}=await fixture();
  const quota=()=>{throw new DOMException('The storage quota was exceeded.','QuotaExceededError');};
  try{
    const payload=await buildBackupPayload(db);
    await api('/expenses',{commandId:commandId(),branchId:'b1',category:'Other',description:'Existing transaction',amount:500,paymentMethod:'card'});
    const before=await contents(db);
    db.credentials.hook('creating',quota);
    await assert.rejects(restoreDeviceBackup(payload,db),(error:any)=>error.code==='STORAGE_FULL'&&error.status===507);
    db.credentials.hook('creating').unsubscribe(quota);
    assert.deepEqual(await contents(db),before);
    assert.equal((await getLocalUser(db))?.role,'owner');
  }finally{db.credentials.hook('creating').unsubscribe(quota);await destroy(db);}
});

test('a draft write interruption preserves business restore and retries the entire device draft set atomically',async()=>{
  const {db}=await fixture();
  const quota=()=>{throw new DOMException('The storage quota was exceeded.','QuotaExceededError');};
  try{
    const restoredDraft=sampleDraft();await browserDb.drafts.put(restoredDraft);
    const payload=await buildBackupPayload(db);
    const oldDraft={...sampleDraft(),note:'Previous device draft'};
    const hubDraft={...sampleDraft('b1'),note:'Keep hub draft'};
    await browserDb.drafts.bulkPut([oldDraft,hubDraft]);
    browserDb.drafts.hook('creating',quota);
    const result=await restoreDeviceBackup(payload,db);
    assert.deepEqual(result,{draftRecoveryPending:true});
    assert.equal(await db.sessions.count(),0);
    assert.ok(await db.metadata.get('pendingRestoredDrafts'));
    assert.deepEqual(await browserDb.drafts.get('device:b1'),oldDraft);
    assert.deepEqual(await browserDb.drafts.get('b1'),hubDraft);
    browserDb.drafts.hook('creating').unsubscribe(quota);
    db.close();await db.open();
    assert.deepEqual(await recoverRestoredDrafts(db),{recovered:true,pending:false});
    assert.deepEqual(await browserDb.drafts.get('device:b1'),restoredDraft);
    assert.deepEqual(await browserDb.drafts.get('b1'),hubDraft);
    assert.equal(await db.metadata.get('pendingRestoredDrafts'),undefined);
    assert.deepEqual(await recoverRestoredDrafts(db),{recovered:false,pending:false});
  }finally{browserDb.drafts.hook('creating').unsubscribe(quota);await destroy(db);}
});

test('owner authorization is required for export and populated restore even when its setup marker is missing',async()=>{
  const {db,store}=await fixture();
  try{
    const payload=await buildBackupPayload(db);
    const owner=await store.get<StaffMember>('staff','staff-owner');
    await store.put('staff',{...owner!,role:'cashier',branchId:'b1'});
    await assert.rejects(buildBackupPayload(db),/Only the device workspace owner/);
    await assert.rejects(restoreDeviceBackup(payload,db),/Only the device workspace owner/);
    await store.put('staff',owner!);
    await db.metadata.delete('workspace');
    forgetLocalSession(db);
    const before=await contents(db);
    await assert.rejects(restoreDeviceBackup(payload,db),/Only the device workspace owner/);
    assert.deepEqual(await contents(db),before);
  }finally{await destroy(db);}
});

test('verified import into an empty device needs no previous login and never imports sessions',async()=>{
  const {db}=await fixture();
  const empty=new LocalDatabase(`local-backup-empty-${commandId()}`);
  try{
    const payload=await buildBackupPayload(db);
    await restoreDeviceBackup(payload,empty);
    assert.equal(await empty.sessions.count(),0);
    assert.equal(await getLocalUser(empty),null);
    assert.equal((await loginLocal(pin,undefined,empty)).role,'owner');
    const api=createLocalApi(empty);
    assert.equal((await api<Snapshot>('/bootstrap')).settings.businessName,'Backup Restaurant');
  }finally{await destroy(db);await destroy(empty);}
});
