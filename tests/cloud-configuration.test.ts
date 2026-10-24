import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseServiceAccount} from '../server/monitor/store';

const account={project_id:'test-project',client_email:'pos@example.test',private_key:'-----BEGIN PRIVATE KEY-----\\nEXAMPLE-ONLY\\n-----END PRIVATE KEY-----\\n'};

test('service-account configuration accepts JSON, JSON-wrapped JSON and base64 JSON without evaluating code',()=>{
  const json=JSON.stringify(account);
  for(const input of [json,JSON.stringify(json),Buffer.from(json).toString('base64')]){
    const parsed=parseServiceAccount(input);
    assert.equal(parsed.project_id,account.project_id);assert.equal(parsed.client_email,account.client_email);
    assert.equal(parsed.private_key,account.private_key.replace(/\\n/g,'\n'));
  }
  const globalObject=globalThis as typeof globalThis&{cloudParserExecuted?:boolean};
  assert.throws(()=>parseServiceAccount('(globalThis.cloudParserExecuted = true, {project_id:"test-project",client_email:"pos@example.test",private_key:"PRIVATE"})'),/valid JSON/);
  assert.equal(globalObject.cloudParserExecuted,undefined);
});

test('invalid service-account configuration reports no private key, raw JSON prefix or malformed input',()=>{
  const secret='UNIQUE-PRIVATE-KEY-MARKER';
  for(const input of [`{"private_key":"${secret}",`,JSON.stringify({private_key:secret}),JSON.stringify([account]),'null']){
    assert.throws(()=>parseServiceAccount(input),error=>{
      assert.ok(error instanceof Error);assert.match(error.message,/Firebase service account configuration/);
      assert.doesNotMatch(error.message,new RegExp(`${secret}|Prefix|SyntaxError|Unexpected token`));return true;
    });
  }
});
