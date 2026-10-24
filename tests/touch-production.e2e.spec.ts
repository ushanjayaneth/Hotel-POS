import {test,expect} from '@playwright/test';

test.setTimeout(90000);
test('touch keypads take quantities and cash; gram recipes and wastage keep stock and costs consistent',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:'Set up this device',exact:true}).click();
  const setup=page.getByRole('dialog',{name:'Set up this device',exact:true});
  await setup.getByLabel(/^Owner PIN/).fill('98765432');await setup.getByLabel('Confirm owner PIN',{exact:true}).fill('98765432');await setup.getByRole('checkbox',{name:/^Include sample menu/}).check();await setup.getByRole('button',{name:'Create device workspace',exact:true}).click();
  await page.getByRole('button',{name:'Add Ceylon milk tea',exact:true}).click();await page.getByRole('button',{name:'Enter quantity for Ceylon milk tea',exact:true}).click();
  let pad=page.getByRole('dialog',{name:'Item quantity',exact:true});await pad.getByRole('button',{name:'2',exact:true}).click();await pad.getByRole('button',{name:'Apply',exact:true}).click();
  await expect(page.locator('.order-total')).toContainText('300.00');await page.getByRole('button',{name:'Charge order',exact:true}).click();
  let payment=page.getByRole('dialog',{name:'Take payment',exact:true});await payment.getByRole('button',{name:'Enter cash received with keypad',exact:true}).click();
  pad=page.getByRole('dialog',{name:'Cash received (LKR)',exact:true});for(const key of ['5','0','0'])await pad.getByRole('button',{name:key,exact:true}).click();await pad.getByRole('button',{name:'Apply',exact:true}).click();
  await expect(payment.getByLabel('Cash received (LKR)',{exact:true})).toHaveValue('500');await expect(payment.locator('.change-due')).toContainText('200.00');await payment.getByRole('button',{name:'Confirm payment',exact:true}).click();await page.getByRole('dialog',{name:'Order receipt',exact:true}).getByRole('button',{name:'Close',exact:true}).click();
  const nav=async(name:string)=>page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:new RegExp(`^${name}`)}).click();
  await nav('Production');const row=page.getByRole('row').filter({hasText:'Vegetable rice & curry'});await row.getByRole('button',{name:/ingredients|Set up recipe/}).click();
  const recipe=page.getByRole('dialog',{name:/^Recipe/});await recipe.getByLabel('Recipe yield (portions)',{exact:true}).fill('2');await recipe.getByRole('combobox',{name:'Quantity unit 1',exact:true}).selectOption('g');await recipe.getByLabel(/^Batch quantity/).nth(0).fill('400');await recipe.getByRole('button',{name:'Save recipe',exact:true}).click();await expect(recipe).toHaveCount(0);
  const read=async(kind:string,id:string)=>page.evaluate(({kind,id})=>new Promise<any>((resolve,reject)=>{const open=indexedDB.open('demo-hotel-local-workspace-v1');open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction('records'),request=tx.objectStore('records').get([kind,id]);tx.oncomplete=()=>{db.close();resolve(request.result?.value);};tx.onabort=()=>reject(tx.error);};}),{kind,id});
  const saved=await read('recipe','m2');expect(saved.ingredients.find((line:{key:string})=>line.key==='rice').quantity).toBe(.2);expect(saved.batchYield).toBe(2);
  await nav('Inventory');const before=await read('inventory','b1-rice');await page.getByRole('button',{name:'Record wastage',exact:true}).click();
  const waste=page.getByRole('dialog',{name:'Record wastage',exact:true});await waste.getByRole('combobox',{name:'Stock item',exact:true}).selectOption('b1-rice');await waste.getByLabel('Quantity wasted (stock unit)',{exact:true}).fill('.5');await waste.getByLabel('Details (optional)',{exact:true}).fill('Opened bag spoiled');await waste.getByRole('button',{name:'Record stock loss',exact:true}).click();await expect(waste).toHaveCount(0);
  expect((await read('inventory','b1-rice')).quantity).toBe(before.quantity-.5);await expect(page.getByRole('region',{name:'Wastage and spoilage log'})).toContainText('Opened bag spoiled');const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export wastage',exact:true}).click();expect((await download).suggestedFilename()).toBe('wastage-log.csv');
});
