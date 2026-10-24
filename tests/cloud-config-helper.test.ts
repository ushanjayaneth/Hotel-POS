import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join,resolve,dirname,basename} from 'node:path';
import {spawnSync} from 'node:child_process';
import {scryptSync} from 'node:crypto';

const helper=resolve('scripts/create-cloud-config.mjs');
function fixture(){
  const parent=resolve('artifacts');mkdirSync(parent,{recursive:true});
  const directory=mkdtempSync(join(parent,'config-helper-test-'));
  const servicePath=join(directory,'example-admin.json');
  writeFileSync(servicePath,JSON.stringify({project_id:'example-project',client_email:'example@example.test',private_key:'EXAMPLE-ONLY-PRIVATE-KEY'}));
  const invoke=(args:string[],pin?:string)=>{
    const environment={...process.env};delete environment.POS_SETUP_PIN;if(pin!==undefined)environment.POS_SETUP_PIN=pin;
    return spawnSync(process.execPath,[helper,...args],{cwd:directory,env:environment,encoding:'utf8'});
  };
  const generated=()=>{const root=join(directory,'artifacts','cloud-config'),entry=readdirSync(root)[0];return join(root,entry);};
  const close=()=>{assert.equal(dirname(resolve(directory)),parent);assert.ok(basename(directory).startsWith('config-helper-test-'));rmSync(directory,{recursive:true,force:true});};
  return {servicePath,invoke,generated,close};
}
function checkHash(directory:string,pin:string){
  const [format,salt,digest]=readFileSync(join(directory,'CLOUD_POS_PIN_HASH.txt'),'utf8').split('$');
  assert.equal(format,'scrypt');assert.equal(salt.length,64);assert.equal(digest,scryptSync(pin,Buffer.from(salt,'hex'),64).toString('hex'));
}

test('cloud config helper creates one generated POS PIN and four server values without printing credentials',()=>{
  const f=fixture();try{
    const result=f.invoke([f.servicePath,'https://example-project.firebaseio.com/']);assert.equal(result.status,0,result.stderr);
    const directory=f.generated(),files=readdirSync(directory).sort();
    assert.deepEqual(files,['CLOUD_POS_PIN_HASH.txt','CLOUD_SESSION_SECRET.txt','FIREBASE_DATABASE_URL.txt','FIREBASE_SERVICE_ACCOUNT_JSON.txt','POS-PIN.txt']);
    const pin=/^POS PIN: ([0-9]{8})/m.exec(readFileSync(join(directory,'POS-PIN.txt'),'utf8'))?.[1];assert.ok(pin);checkHash(directory,pin);
    assert.doesNotMatch(result.stdout+result.stderr,new RegExp(`${pin}|EXAMPLE-ONLY-PRIVATE-KEY|scrypt\\$`));assert.match(result.stdout,/4 environment-value files/);
  }finally{f.close();}
});

test('cloud config helper accepts an existing PIN only through its environment and preserves the three-argument legacy form',()=>{
  const f=fixture();try{
    const pin='975318642';const result=f.invoke(['owner@example.test',f.servicePath,'https://example-project.firebaseio.com/'],pin);assert.equal(result.status,0,result.stderr);
    const directory=f.generated();checkHash(directory,pin);assert.match(readFileSync(join(directory,'POS-PIN.txt'),'utf8'),/^POS PIN: 975318642/m);
    assert.ok(readdirSync(directory).includes('OWNER-LOGIN.txt'));assert.equal(readFileSync(join(directory,'CLOUD_OWNER_EMAIL.txt'),'utf8'),'owner@example.test');
    assert.match(result.stdout,/6 environment-value files/);assert.doesNotMatch(result.stdout+result.stderr,/975318642|EXAMPLE-ONLY-PRIVATE-KEY|scrypt\$/);
  }finally{f.close();}
});

test('cloud config helper rejects weak PIN input before writing private output',()=>{
  const f=fixture();try{
    for(const pin of ['1234','abcdef','123456 ','']){const result=f.invoke([f.servicePath,'https://example-project.firebaseio.com/'],pin);assert.notEqual(result.status,0);assert.match(result.stderr,/POS_SETUP_PIN must contain 6 to 16 digits/);}
    assert.deepEqual(readdirSync(dirname(f.servicePath)),['example-admin.json']);
  }finally{f.close();}
});
