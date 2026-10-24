import 'fake-indexeddb/auto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LocalDatabase} from '../src/lib/local/db';
import {deviceStorageStatus,requestDevicePersistence} from '../src/lib/local/storage';

async function fixture(storage:Partial<StorageManager>){
  const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{storage}});
  const db=new LocalDatabase(`storage-test-${crypto.randomUUID()}`);
  return {db,close:async()=>{await db.delete();if(previous)Object.defineProperty(globalThis,'navigator',previous);else Reflect.deleteProperty(globalThis,'navigator');}};
}

test('automatic storage persistence is claimed once across concurrent launches and a denied request is not repeated after reopening',async()=>{
  let requests=0;
  const f=await fixture({persisted:async()=>false,persist:async()=>{requests++;return false;}});
  const otherTab=new LocalDatabase(f.db.name);
  try{
    assert.deepEqual(await Promise.all([requestDevicePersistence(false,f.db),requestDevicePersistence(false,otherTab)]),[false,false]);
    assert.equal(requests,1);
    f.db.close();await f.db.open();
    assert.equal(await requestDevicePersistence(false,f.db),false);
    assert.equal(requests,1);
    assert.equal((await deviceStorageStatus(f.db)).attempted,true);
    assert.equal(await requestDevicePersistence(true,f.db),false);
    assert.equal(requests,2,'only an explicit Settings retry can repeat the request');
  }finally{otherTab.close();await f.close();}
});

test('already persistent storage never requests permission again, including manual retry',async()=>{
  let requests=0;
  const f=await fixture({persisted:async()=>true,persist:async()=>{requests++;return true;}});
  try{
    assert.equal(await requestDevicePersistence(false,f.db),true);
    assert.equal(await requestDevicePersistence(true,f.db),true);
    assert.equal(requests,0);
  }finally{await f.close();}
});

test('unsupported persistence does not consume the first supported request',async()=>{
  const storage:Partial<StorageManager>={persisted:async()=>false};
  let requests=0;
  const f=await fixture(storage);
  try{
    assert.equal(await requestDevicePersistence(false,f.db),false);
    assert.equal(await f.db.metadata.get('storagePersistenceAttempted'),undefined);
    storage.persist=async()=>{requests++;return true;};
    assert.equal(await requestDevicePersistence(false,f.db),true);
    assert.equal(requests,1);
  }finally{await f.close();}
});

test('a browser persistence exception is remembered without making workspace storage unavailable',async()=>{
  let requests=0;
  const f=await fixture({persisted:async()=>false,persist:async()=>{requests++;throw new DOMException('Denied','NotAllowedError');}});
  try{
    assert.equal(await requestDevicePersistence(false,f.db),false);
    assert.equal(await requestDevicePersistence(false,f.db),false);
    assert.equal(requests,1);
    const status=await deviceStorageStatus(f.db);
    assert.equal(status.available,true);assert.equal(status.attempted,true);assert.equal(status.persistent,false);
  }finally{await f.close();}
});

test('storage estimates and persistence are checked independently; an unavailable database never triggers a permission prompt',async()=>{
  let requests=0,persistent=true;
  const f=await fixture({estimate:async()=>{throw new Error('Estimate withheld');},persisted:async()=>persistent,persist:async()=>{requests++;return true;}});
  try{
    const status=await deviceStorageStatus(f.db);
    assert.equal(status.persistent,true);assert.equal(status.usage,null);assert.equal(status.available,true);
    f.db.close({disableAutoOpen:true});persistent=false;
    assert.equal(await requestDevicePersistence(false,f.db),false);
    assert.equal(requests,0);
    assert.equal((await deviceStorageStatus(f.db)).available,false);
  }finally{await f.close();}
});
