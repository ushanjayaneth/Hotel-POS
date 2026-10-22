import {test} from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {createApp} from '../server/app';
import {LocalDatabase} from '../src/lib/local/db';
import {initializeLocalWorkspace} from '../src/lib/local/seed';
import {createLocalApi} from '../src/lib/local/core';
import type {Snapshot} from '../shared/types';
import {businessDate,profitability} from '../shared/costing';
import {convertQuantity,compatibleUnits} from '../shared/units';

test('weight and volume convert once in both directions and incompatible dimensions are rejected',()=>{
  assert.equal(convertQuantity(200,'g','kg'),.2);assert.equal(convertQuantity(.2,'kg','g'),200);assert.equal(convertQuantity(25,'ml','L'),.025);assert.equal(convertQuantity(1500,'mg','g'),1.5);
  assert.equal(convertQuantity(2,'pcs','pcs'),2);assert.deepEqual(compatibleUnits('L'),['L','ml']);assert.throws(()=>convertQuantity(1,'g','L'));assert.throws(()=>convertQuantity(-1,'g','kg'));
});
for(const mode of ['hub','device'] as const)test(`${mode}: wastage reduces stock once, captures cost, leaves drawer unchanged and contributes to the profit estimate`,async()=>{
  const app=mode==='hub'?await createApp({databasePath:':memory:',seed:true}):null;
  const db=mode==='device'?new LocalDatabase(`waste-${crypto.randomUUID()}`):null;let cookie='';
  const local=db?createLocalApi(db):null;
  try{
    if(db)await initializeLocalWorkspace({businessName:'Waste Test',ownerName:'Owner',pin:'98765432',demo:true},db);
    else cookie=(await app!.inject({method:'POST',url:'/api/login',payload:{pin:'1234'}})).headers['set-cookie']!.toString().split(';')[0];
    const api=async<T>(path:string,body?:unknown):Promise<T>=>{
      if(local)return local<T>(path,body);
      const response=await app!.inject({method:body===undefined?'GET':'POST',url:`/api${path}`,headers:{cookie},payload:body as any});
      if(response.statusCode>=400)throw Object.assign(new Error(response.body),{status:response.statusCode});return response.json() as T;
    };
    const before=await api<Snapshot>('/bootstrap?branchId=b1'),rice=before.inventory.find(item=>item.id==='b1-rice')!;
    const command={commandId:'wastage-regression-command',branchId:'b1',itemId:rice.id,quantity:.25,reason:'Expired / spoiled: damaged container'};
    await api('/inventory/wastage',command);await api('/inventory/wastage',command);
    const after=await api<Snapshot>('/bootstrap?branchId=b1'),waste=after.stockMovements.filter(row=>row.type==='waste');
    assert.equal(after.inventory.find(item=>item.id===rice.id)!.quantity,rice.quantity-.25);assert.equal(waste.length,1);assert.equal(waste[0].totalCost,Math.round(rice.unitCost*.25));assert.equal(after.shifts[0].expectedCash,before.shifts[0].expectedCash);assert.equal(after.expenses.length,before.expenses.length);
    const report=profitability(after,businessDate(waste[0].createdAt));assert.equal(report.wastageCost,waste[0].totalCost);assert.equal(report.operatingProfit,report.grossProfit-report.cancelledCost-report.operatingExpenses-report.wastageCost);
    await assert.rejects(api('/inventory/wastage',{...command,commandId:'wastage-insufficient-command',quantity:100000}));
    assert.equal((await api<Snapshot>('/bootstrap?branchId=b1')).stockMovements.filter(row=>row.type==='waste').length,1);
  }finally{if(app)await app.close();if(db)await db.delete();}
});
