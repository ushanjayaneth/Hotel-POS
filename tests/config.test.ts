import {test} from 'node:test';
import assert from 'node:assert/strict';
import {firebaseDatabaseUrl} from '../server/config';
import {createApp} from '../server/app';

test('Firebase origin is validated only in backend configuration',()=>{
  const previous=process.env.FIREBASE_DATABASE_URL;
  try {
    delete process.env.FIREBASE_DATABASE_URL;
    assert.equal(firebaseDatabaseUrl(),undefined);
    process.env.FIREBASE_DATABASE_URL='https://example-default-rtdb.firebaseio.com/';
    assert.equal(firebaseDatabaseUrl(),'https://example-default-rtdb.firebaseio.com');
    for(const invalid of ['http://example.com/','https://user:secret@example.com/','https://example.com/data','https://example.com/?auth=secret']){
      process.env.FIREBASE_DATABASE_URL=invalid;
      assert.throws(()=>firebaseDatabaseUrl());
    }
  } finally {if(previous===undefined)delete process.env.FIREBASE_DATABASE_URL;else process.env.FIREBASE_DATABASE_URL=previous;}
});

test('authenticated bootstrap never exposes the Firebase URL or server credentials',async()=>{
  const previous=process.env.FIREBASE_DATABASE_URL;
  process.env.FIREBASE_DATABASE_URL='https://private-example-default-rtdb.firebaseio.com/';
  const app=await createApp({databasePath:':memory:',seed:true});
  try {
    const login=await app.inject({method:'POST',url:'/api/login',payload:{pin:'1234'}});
    const cookie=login.cookies.map(item=>`${item.name}=${item.value}`).join('; ');
    const bootstrap=await app.inject({url:'/api/bootstrap',headers:{cookie}});
    assert.equal(bootstrap.statusCode,200);
    const state=bootstrap.json();
    assert.equal(Object.hasOwn(state.sync,'databaseUrl'),false);
    assert.equal(bootstrap.body.includes('private-example-default-rtdb'),false);
    assert.equal(bootstrap.body.includes('FIREBASE_DATABASE_URL'),false);
    assert.equal(bootstrap.body.includes('GOOGLE_APPLICATION_CREDENTIALS'),false);
  } finally {await app.close();if(previous===undefined)delete process.env.FIREBASE_DATABASE_URL;else process.env.FIREBASE_DATABASE_URL=previous;}
});
