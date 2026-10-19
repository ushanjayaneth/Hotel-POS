import 'fake-indexeddb/auto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {InventoryItem, Order, Snapshot, User} from '../shared/types';
import {LocalDatabase, LocalStore} from '../src/lib/local/db';
import {createLocalApi, getLocalUser, getLocalWorkspaceInfo, initializeLocalWorkspace} from '../src/lib/local/core';
import {forgetLocalSession} from '../src/lib/local/auth';
import {LocalError} from '../src/lib/local/types';

const pin = '9876543210';
const commandId = () => crypto.randomUUID();
async function fixture(demo = true) {
  const db = new LocalDatabase(`local-core-${commandId()}`);
  const initialized = await initializeLocalWorkspace({businessName:'Test restaurant',ownerName:'Private Owner',pin,demo},db);
  return {db,api:createLocalApi(db),store:new LocalStore(db),...initialized};
}
const failure = (code: string, status: number) => (error: unknown) => error instanceof LocalError && error.code === code && error.status === status;
async function destroy(db: LocalDatabase) {forgetLocalSession(db); await db.delete();}

test('private setup persists once, hashes the owner PIN, and never replaces live data or creates demo access',async()=>{
  const {db,api,workspace,user}=await fixture(false);
  try {
    assert.equal(user.role,'owner');
    assert.equal((await getLocalUser(db))?.id,user.id);
    const info=await getLocalWorkspaceInfo(db);assert.deepEqual(info,workspace);assert.equal(info!.demo,false);
    const state=await api<Snapshot>('/api/bootstrap?branchId=b1');
    assert.equal(state.staff.length,1);assert.equal(state.branches.length,1);assert.equal(state.menu.length,0);assert.equal(state.orders.length,0);assert.equal(state.shifts.length,0);assert.equal(state.settings.businessName,'Test restaurant');
    const credentials=await db.credentials.toArray();assert.equal(credentials.length,1);assert.equal(credentials[0].algorithm,'PBKDF2-SHA256');assert.ok(credentials[0].iterations>=600000);assert.notEqual(credentials[0].hash,pin);
    assert.equal(JSON.stringify(await db.records.toArray()).includes(pin),false);assert.equal(JSON.stringify(await db.metadata.toArray()).includes(pin),false);assert.equal(JSON.stringify(state).includes(credentials[0].hash),false);
    db.close();await db.open();assert.deepEqual(await getLocalWorkspaceInfo(db),workspace);
    const repeated=await initializeLocalWorkspace({businessName:'Do not overwrite',ownerName:'Another Owner',pin,demo:true},db);
    assert.deepEqual(repeated.workspace,workspace);assert.equal((await api<Snapshot>('/bootstrap')).settings.businessName,'Test restaurant');assert.equal(await db.credentials.count(),1);
    await api('/logout',{});assert.equal(await getLocalUser(db),null);assert.deepEqual(await getLocalWorkspaceInfo(db),workspace);
    await assert.rejects(api('/login',{pin:'1234'}),failure('INVALID_CREDENTIALS',401));
    await assert.rejects(initializeLocalWorkspace({businessName:'Replace live',ownerName:'Intruder',pin:'1234',demo:true},db),failure('INVALID_CREDENTIALS',401));
    assert.equal((await api<{user:User}>('/login',{pin})).user.role,'owner');
  }finally{await destroy(db);}
});

test('concurrent duplicate orders and payment retries commit stock, drawer and journal exactly once across a reopen',async()=>{
  const {db,api,store}=await fixture();
  try {
    const before=await store.get<InventoryItem>('inventory','b1-prepared-m1');
    const payload={commandId:commandId(),branchId:'b1',type:'takeaway',lines:[{menuItemId:'m1',quantity:2}]};
    const [first,duplicate]=await Promise.all([api<{order:Order}>('/orders',payload),api<{order:Order}>('/api/orders',payload)]);
    assert.deepEqual(first,duplicate);assert.equal((await store.list('order')).length,1);assert.equal((await store.get<InventoryItem>('inventory',before!.id))!.quantity,before!.quantity-2);assert.equal(await db.commands.count(),1);assert.equal(await db.journal.count(),1);
    const journal=(await db.journal.toArray())[0];assert.ok(journal.changes.some(change=>change.kind==='order'));assert.ok(journal.changes.some(change=>change.kind==='inventory'));assert.ok(journal.changes.some(change=>change.kind==='audit'));assert.equal(journal.sequence,1);
    await assert.rejects(api('/orders',{...payload,lines:[{menuItemId:'m1',quantity:3}]}),failure('IDEMPOTENCY_CONFLICT',409));
    const order=first.order;const payment={commandId:commandId(),expectedVersion:order.version,method:'cash',amount:order.total,received:order.total};
    const paid=await api<{order:Order}>(`/orders/${order.id}/payments`,payment);assert.equal(paid.order.paid,order.total);
    db.close();await db.open();
    assert.deepEqual(await api(`/orders/${order.id}/payments`,payment),paid);assert.deepEqual(await api('/orders',payload),first);
    const state=await api<Snapshot>('/bootstrap');assert.equal(state.orders.length,1);assert.equal(state.orders[0].payments.length,1);assert.equal(state.shifts[0].expectedCash,order.total);assert.equal(await db.commands.count(),2);assert.equal(await db.journal.count(),2);assert.equal((await store.meta<number>('journalSequence')),2);
  }finally{await destroy(db);}
});

test('a storage failure after business writes rolls back records, command acknowledgement and journal together',async()=>{
  const {db,api,store}=await fixture();
  const quota=()=>{throw new DOMException('The storage quota was exceeded.','QuotaExceededError');};
  try {
    const before=await store.get<InventoryItem>('inventory','b1-prepared-m1');
    const payload={commandId:commandId(),branchId:'b1',type:'takeaway',lines:[{menuItemId:'m1',quantity:2}]};
    db.journal.hook('creating',quota);
    await assert.rejects(api('/orders',payload),failure('STORAGE_FULL',507));
    db.journal.hook('creating').unsubscribe(quota);
    assert.deepEqual(await store.get('inventory',before!.id),before);assert.equal((await store.list('order')).length,0);assert.equal((await store.list('movement')).length,0);assert.equal(await db.commands.count(),0);assert.equal(await db.journal.count(),0);assert.equal(await store.meta('journalSequence'),0);
    await api('/orders',payload);assert.equal((await store.list('order')).length,1);assert.equal(await db.commands.count(),1);
  }finally{db.journal.hook('creating').unsubscribe(quota);await destroy(db);}
});

test('failed first setup leaves no durable completion flag, credential, session or partial catalog',async()=>{
  const db=new LocalDatabase(`local-setup-full-${commandId()}`);
  const quota=()=>{throw new DOMException('The storage quota was exceeded.','QuotaExceededError');};
  try {
    db.credentials.hook('creating',quota);
    await assert.rejects(initializeLocalWorkspace({businessName:'Live restaurant',ownerName:'Owner User',pin,demo:false},db),failure('STORAGE_FULL',507));
    assert.equal(await getLocalWorkspaceInfo(db),null);assert.equal(await db.records.count(),0);assert.equal(await db.metadata.count(),0);assert.equal(await db.credentials.count(),0);assert.equal(await db.sessions.count(),0);assert.equal(await getLocalUser(db),null);
    db.credentials.hook('creating').unsubscribe(quota);
    await initializeLocalWorkspace({businessName:'Live restaurant',ownerName:'Owner User',pin,demo:false},db);assert.ok(await getLocalWorkspaceInfo(db));
  }finally{db.credentials.hook('creating').unsubscribe(quota);await destroy(db);}
});

test('local sessions enforce staff roles and branch scope and never expose credentials in a cashier snapshot',async()=>{
  const {db,api,store}=await fixture();
  try {
    await store.put('branch',{id:'b2',name:'Another branch',nameSi:'Another branch',code:'OTHER',address:'',phone:''});
    const staffInput={commandId:commandId(),name:'Local Cashier',role:'cashier',branchId:'b1',pin:'456789',phone:''};
    const staff=await api<{staff:{id:string}}>('/staff',staffInput);
    assert.deepEqual(await api('/staff',staffInput),staff);
    const serialized=JSON.stringify({commands:await db.commands.toArray(),journal:await db.journal.toArray()});assert.equal(serialized.includes(staffInput.pin),false);
    await api('/logout',{});await api('/login',{pin:staffInput.pin,staffId:staff.staff.id});
    const state=await api<Snapshot>('/bootstrap?branchId=b1');assert.equal(state.user.role,'cashier');assert.equal(state.branches.length,1);assert.ok(state.menu.every(item=>item.cost===0));assert.deepEqual(state.staff,[]);assert.deepEqual(state.inventory,[]);assert.deepEqual(state.recipes,[]);
    await assert.rejects(api('/bootstrap?branchId=b2'),failure('BRANCH_FORBIDDEN',403));
    await assert.rejects(api('/settings',{commandId:commandId(),businessName:'Forbidden'},'PUT'),failure('FORBIDDEN',403));
    const ownerCredential=await db.credentials.get('staff-owner');assert.equal(JSON.stringify(state).includes(ownerCredential!.hash),false);
    await db.sessions.toCollection().modify({expiresAt:0});assert.equal(await getLocalUser(db),null);
    await assert.rejects(api('/orders',{commandId:commandId(),branchId:'b1',type:'takeaway',lines:[{menuItemId:'m1',quantity:1}]}),failure('UNAUTHENTICATED',401));assert.ok(await getLocalWorkspaceInfo(db));
  }finally{await destroy(db);}
});
