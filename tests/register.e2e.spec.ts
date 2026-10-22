import {test,expect,type Page} from '@playwright/test';
import type {CreditEntry,Customer,InventoryItem,Order} from '../shared/types';

test.setTimeout(90_000);
async function setup(page:Page){
  await page.route('**/api/**',route=>route.fulfill({status:404,body:'NOT_FOUND'}));
  await page.goto('/');await page.getByRole('button',{name:'Set up this device',exact:true}).click();
  const setup=page.getByRole('dialog',{name:'Set up this device',exact:true});
  await setup.getByLabel(/^Owner PIN/).fill('98765432');await setup.getByLabel('Confirm owner PIN',{exact:true}).fill('98765432');
  await setup.getByRole('checkbox',{name:/^Include sample menu/}).check();
  await setup.getByRole('button',{name:'Create device workspace',exact:true}).click();
  await expect(page.getByRole('heading',{level:1,name:/Point of sale/})).toBeVisible();
}
async function navigate(page:Page,name:string){await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:new RegExp(`^${name}`)}).click();}
async function records<T>(page:Page,kind:string):Promise<T[]>{
  return page.evaluate(kind=>new Promise<unknown[]>((resolve,reject)=>{const request=indexedDB.open('demo-hotel-local-workspace-v1');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction('records');const rows=tx.objectStore('records').getAll();tx.oncomplete=()=>{db.close();resolve(rows.result.filter(row=>row.kind===kind).map(row=>row.value));};tx.onabort=()=>reject(tx.error);};}),kind) as Promise<T[]>;
}
test('counter sale needs no table, applies rupee item and cart discounts, clears cart and shows remaining low stock',async({page})=>{
  await setup(page);await navigate(page,'Products');await page.getByRole('button',{name:'Add product',exact:true}).click();
  const product=page.getByRole('dialog',{name:'Add product',exact:true});
  await product.getByLabel('Product name',{exact:true}).fill('Counter retail');
  await product.getByLabel('Selling price (LKR)',{exact:true}).fill('350');
  await product.getByLabel('Cost per unit (LKR)',{exact:true}).fill('200');
  await product.getByLabel('Low stock alert at',{exact:true}).fill('');
  await product.getByLabel('Opening stock quantity',{exact:true}).fill('6');
  await product.getByRole('button',{name:'Add product',exact:true}).click();await expect(product).toHaveCount(0);
  await navigate(page,'Point of sale');const card=page.locator('.product-card').filter({has:page.getByRole('heading',{name:'Counter retail',exact:true})});
  await expect(card).not.toHaveClass(/low-stock/);await card.getByRole('button',{name:'Add Counter retail',exact:true}).click();
  await page.getByRole('button',{name:'Add one more Counter retail',exact:true}).click();
  await page.getByRole('button',{name:'Discount Counter retail',exact:true}).click();
  const itemDiscount=page.getByRole('dialog',{name:'Item discount',exact:true});await itemDiscount.getByLabel('Discount amount (LKR)',{exact:true}).fill('50');await itemDiscount.getByRole('button',{name:'Apply discount',exact:true}).click();
  await page.getByRole('button',{name:'Add cart discount',exact:true}).click();const cartDiscount=page.getByRole('dialog',{name:'Cart discount',exact:true});await cartDiscount.getByLabel('Discount amount (LKR)',{exact:true}).fill('20');await cartDiscount.getByRole('button',{name:'Apply discount',exact:true}).click();
  await expect(page.locator('.order-total')).toContainText('630.00');await page.getByRole('button',{name:'Charge order',exact:true}).click();
  const payment=page.getByRole('dialog',{name:'Take payment',exact:true});await expect(payment.getByLabel('Cash received (LKR)',{exact:true})).toHaveValue('630');await payment.getByRole('button',{name:'Confirm payment',exact:true}).click();
  const receipt=page.getByRole('dialog',{name:'Order receipt',exact:true});await expect(receipt).toContainText('630.00');await expect(receipt).toContainText('Item discounts');await expect(receipt).toContainText('Cart discount');await receipt.getByRole('button',{name:'Close',exact:true}).click();
  await expect(page.getByRole('heading',{name:'A fresh start.',exact:true})).toBeVisible();await expect(card).toHaveClass(/low-stock/);await expect(card).toContainText('4 left');await expect(card).toHaveCSS('border-top-color','rgb(239, 155, 69)');await expect(card).toHaveCSS('border-top-width','1px');await page.screenshot({path:'artifacts/register-low-stock.png',fullPage:true});
  const [order]=await records<Order>(page,'order');expect(order.type).toBe('takeaway');expect(order.tableId).toBeNull();expect(order.subtotal).toBe(70000);expect(order.discount).toBe(7000);expect(order.cartDiscount).toBe(2000);expect(order.lines[0].discount).toBe(5000);expect(order.total).toBe(63000);
  expect((await records<InventoryItem>(page,'inventory')).find(item=>item.menuItemId===order.lines[0].menuItemId)?.quantity).toBe(4);
});
test('POS creates a named loan customer, records items and dues, then accepts a later repayment',async({page})=>{
  await setup(page);await page.getByRole('button',{name:'Add Chicken rice & curry',exact:true}).click();await page.getByRole('button',{name:/^Customer Loan/}).click();
  const customer=page.getByRole('dialog',{name:'Customer Loan',exact:true});const newCustomer=customer.getByRole('button',{name:'New customer',exact:true});if(await newCustomer.isVisible())await newCustomer.click();
  await customer.getByLabel('Customer name',{exact:true}).fill('POS Credit Guest');await customer.getByLabel('Phone number',{exact:true}).fill('0771231234');await customer.getByRole('button',{name:'Continue to loan',exact:true}).click();
  const payment=page.getByRole('dialog',{name:'Take payment',exact:true});await expect(payment).toContainText('POS Credit Guest');await payment.getByRole('checkbox').check();await payment.getByRole('button',{name:'Confirm customer loan',exact:true}).click();
  const receipt=page.getByRole('dialog',{name:'Order receipt',exact:true});await expect(receipt).toBeVisible();await receipt.getByRole('button',{name:'Close',exact:true}).click();await expect(page.getByRole('heading',{name:'A fresh start.',exact:true})).toBeVisible();
  const [order]=await records<Order>(page,'order');const guest=(await records<Customer>(page,'customer')).find(item=>item.name==='POS Credit Guest')!;expect(order.customerId).toBe(guest.id);expect(order.payments[0].method).toBe('credit');expect((await records<CreditEntry>(page,'credit')).find(item=>item.customerId===guest.id)?.amount).toBe(65000);
  await navigate(page,'Customers & dues');const customerRow=page.getByRole('row').filter({hasText:'POS Credit Guest'});await customerRow.getByRole('button',{name:'Ledger & collect',exact:true}).click();const ledger=page.getByRole('dialog',{name:'Customer ledger & collection',exact:true});await expect(ledger).toContainText('Chicken rice & curry');await expect(ledger.getByLabel('Amount received (LKR)',{exact:true})).toHaveValue('650');await ledger.getByLabel('Amount received (LKR)',{exact:true}).fill('200');await ledger.getByRole('button',{name:'Record collection',exact:true}).click();await expect(ledger).toHaveCount(0);
  await expect(customerRow).toContainText('450.00');await customerRow.getByRole('button',{name:'Ledger & collect',exact:true}).click();await expect(ledger.getByLabel('Amount received (LKR)',{exact:true})).toHaveValue('450');await ledger.getByRole('button',{name:'Record collection',exact:true}).click();await expect(ledger).toHaveCount(0);
  const collections=(await records<CreditEntry>(page,'credit')).filter(item=>item.customerId===guest.id&&item.type==='collection');expect(collections).toHaveLength(2);expect(collections.map(entry=>entry.amount).sort((a,b)=>a-b)).toEqual([20000,45000]);await expect(customerRow).toContainText('0.00');
});
test('a fully discounted sale clears the cart without opening a payment dialog and still reaches the kitchen',async({page})=>{
  await setup(page);await page.getByRole('button',{name:'Add Ceylon milk tea',exact:true}).click();
  await page.getByRole('button',{name:'Discount Ceylon milk tea',exact:true}).click();
  const discount=page.getByRole('dialog',{name:'Item discount',exact:true});
  await discount.getByLabel('Discount amount (LKR)',{exact:true}).fill('150');await discount.getByRole('button',{name:'Apply discount',exact:true}).click();
  await expect(page.locator('.order-total')).toContainText('0.00');await page.getByRole('button',{name:'Charge order',exact:true}).click();
  const receipt=page.getByRole('dialog',{name:'Order receipt',exact:true});await expect(receipt).toBeVisible();await expect(page.getByRole('dialog',{name:'Take payment',exact:true})).toHaveCount(0);
  await receipt.getByRole('button',{name:'Close',exact:true}).click();await expect(page.getByRole('heading',{name:'A fresh start.',exact:true})).toBeVisible();
  const [order]=await records<Order>(page,'order');expect(order.total).toBe(0);expect(order.paymentStatus).toBe('paid');expect(order.payments).toHaveLength(0);expect(order.status).toBe('new');expect(order.tableId).toBeNull();
});
