import {test as base, expect, type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import type {Order, Snapshot} from '../shared/types';

const test = base.extend<{runtimeCheck: void}>({
  runtimeCheck: [async ({page}, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await use();
    expect(errors, 'The browser should not encounter uncaught application errors.').toEqual([]);
  }, {auto: true}],
});

async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', {name: 'Explore demo workspace'}).click();
  await expect(page.getByRole('heading', {level: 1, name: /Point of sale/})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Add Chicken rice & curry', exact: true})).toBeVisible();
}

async function navigate(page: Page, name: string) {
  const openNavigation = page.getByRole('button', {name: 'Open navigation'});
  const mobile = await openNavigation.isVisible();
  if (mobile) await openNavigation.click();
  await page.getByRole('navigation', {name: 'Main navigation'})
    .getByRole('button', {name: new RegExp(`^${name}`)}).click();
  if (mobile) await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
}

async function snapshot(page: Page): Promise<Snapshot> {
  const result = await page.request.get('/api/bootstrap?branchId=b1');
  expect(result.ok()).toBeTruthy();
  return result.json() as Promise<Snapshot>;
}

function mutation(page: Page, path: string, method = 'POST') {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method);
}

test('menu filtering, quantity changes and notes keep the guest order accurate', async ({page}) => {
  await login(page);
  await expect(page.getByRole('article')).toHaveCount(12);
  await page.getByRole('tab', {name: /^Beverages/}).click();
  await expect(page.getByRole('article')).toHaveCount(3);
  await page.getByRole('textbox', {name: 'Search menu'}).fill('not-a-real-dish');
  await expect(page.getByRole('heading', {name: 'No dishes found'})).toBeVisible();
  await page.getByRole('button', {name: 'Reset filters'}).click();
  await page.getByRole('textbox', {name: 'Search menu'}).fill('Ceylon milk tea');
  await expect(page.getByRole('article')).toHaveCount(1);
  await page.getByRole('button', {name: 'Add Ceylon milk tea', exact: true}).click();
  await page.getByRole('button', {name: 'Add one more Ceylon milk tea', exact: true}).click();
  const order = page.locator('aside.order-panel');
  await expect(order.locator('.order-total')).toContainText('Rs. 300.00');
  await page.getByRole('button', {name: 'Add note to Ceylon milk tea'}).click();
  const instructions = page.getByRole('dialog', {name: 'Item instructions'});
  await instructions.getByRole('textbox', {name: 'Item instructions'}).fill('Less sugar, please');
  await instructions.getByRole('button', {name: 'Save instructions'}).click();
  await expect(order).toContainText('Less sugar, please');
  await page.getByRole('button', {name: 'Remove one Ceylon milk tea', exact: true}).click();
  await expect(order.locator('.order-total')).toContainText('Rs. 150.00');
  await page.getByRole('button', {name: 'Clear order', exact: true}).click();
  await page.getByRole('dialog', {name: 'Start a new order?'}).getByRole('button', {name: 'Discard draft', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'A fresh start.'})).toBeVisible();
  await expect(order.getByRole('button', {name: 'Charge order'})).toBeDisabled();
});

test('takeaway reaches the kitchen and settles once with an exact cash receipt', async ({page}) => {
  await login(page);
  const before = await snapshot(page);
  await page.getByRole('button', {name: 'Add Chicken rice & curry', exact: true}).click();
  await page.getByRole('button', {name: 'Takeaway', exact: true}).click();
  await expect(page.getByRole('combobox', {name: 'Select table'})).toHaveCount(0);
  const createdResponse = mutation(page, '/api/orders');
  await page.getByRole('button', {name: 'Send to kitchen', exact: true}).click();
  const response = await createdResponse;
  expect(response.ok(), await response.text()).toBeTruthy();
  const {order} = await response.json() as {order: Order};
  expect(order.status).toBe('new');
  expect(order.type).toBe('takeaway');
  expect(order.tableId).toBeNull();
  await expect(page.locator('aside.order-panel')).toContainText(order.number);

  await navigate(page, 'Kitchen display');
  const ticket = page.getByRole('article').filter({has: page.getByRole('heading', {name: order.number, exact: true})});
  await expect(ticket).toBeVisible();
  await ticket.getByRole('button', {name: 'Start preparing'}).click();
  await expect(ticket.getByRole('button', {name: 'Mark ready'})).toBeVisible();
  await ticket.getByRole('button', {name: 'Mark ready'}).click();
  await expect(ticket.getByRole('button', {name: 'Mark served'})).toBeVisible();

  await navigate(page, 'Orders');
  await page.getByRole('textbox', {name: 'Search orders'}).fill(order.number);
  const orderCard = page.getByRole('article').filter({has: page.getByRole('heading', {name: order.number, exact: true})});
  await expect(orderCard).toContainText('ready');
  await orderCard.getByRole('button', {name: 'Take payment', exact: true}).click();
  const payment = page.getByRole('dialog', {name: 'Take payment'});
  await payment.getByRole('button', {name: 'Exact amount', exact: true}).click();
  await expect(payment.getByRole('spinbutton', {name: 'Cash received (LKR)'})).toHaveValue('650');
  const paidResponse = mutation(page, `/api/orders/${order.id}/payments`);
  await payment.getByRole('button', {name: 'Confirm payment'}).click();
  expect((await paidResponse).ok()).toBeTruthy();
  const receipt = page.getByRole('dialog', {name: 'Order receipt'});
  await expect(receipt).toBeVisible();
  await expect(receipt).toContainText(order.number);
  await expect(receipt).toContainText('PAID');
  await expect(receipt).toContainText('Rs. 650.00');
  await expect(receipt.getByRole('button', {name: 'Print receipt'})).toBeVisible();
  await receipt.getByRole('button', {name: 'Close', exact: true}).click();

  const after = await snapshot(page);
  const saved = after.orders.find(item => item.id === order.id)!;
  expect(saved.paymentStatus).toBe('paid');
  // Payment must not remove a meal from the kitchen before guest handoff.
  expect(saved.status).toBe('ready');
  expect(saved.payments).toHaveLength(1);
  expect(saved.payments[0]).toMatchObject({method: 'cash', amount: 65000, received: 65000, change: 0});
  expect(after.orders).toHaveLength(before.orders.length + 1);
  expect(after.inventory.find(item => item.id === 'b1-prepared-m1')!.quantity)
    .toBe(before.inventory.find(item => item.id === 'b1-prepared-m1')!.quantity - 1);
  await navigate(page, 'Kitchen display');
  await expect(ticket.getByRole('button', {name: 'Mark served'})).toBeVisible();
  const servedResponse = mutation(page, `/api/orders/${order.id}/status`, 'PATCH');
  await ticket.getByRole('button', {name: 'Mark served'}).click();
  expect((await servedResponse).ok()).toBeTruthy();
  await expect(ticket).toHaveCount(0);
  expect((await snapshot(page)).orders.find(item => item.id === order.id)!.status).toBe('completed');
});

test('stock correction and a production batch update the actual branch balances', async ({page}) => {
  await login(page);
  const before = await snapshot(page);
  await navigate(page, 'Inventory');
  await page.getByRole('button', {name: 'Adjust stock', exact: true}).click();
  const adjustment = page.getByRole('dialog', {name: 'Adjust inventory'});
  await adjustment.getByRole('combobox', {name: 'Stock item'}).selectOption('b1-rice');
  await adjustment.getByRole('spinbutton', {name: /^Quantity change/}).fill('1');
  await adjustment.getByRole('textbox', {name: 'Reason', exact: true}).fill('Browser test verified stock count');
  const adjustedResponse = mutation(page, '/api/inventory/adjust');
  await adjustment.getByRole('button', {name: 'Record adjustment'}).click();
  expect((await adjustedResponse).ok()).toBeTruthy();
  await expect(adjustment).not.toBeVisible();

  await navigate(page, 'Production');
  await page.getByRole('button', {name: 'New batch', exact: true}).click();
  const batch = page.getByRole('dialog', {name: 'New production batch'});
  await batch.getByRole('combobox', {name: 'Prepared menu item'}).selectOption('m1');
  await batch.getByRole('spinbutton', {name: 'Portions prepared'}).fill('2');
  await batch.getByRole('textbox', {name: 'Batch note (optional)'}).fill('Browser test lunch batch');
  const producedResponse = mutation(page, '/api/production');
  await batch.getByRole('button', {name: 'Record production'}).click();
  expect((await producedResponse).ok()).toBeTruthy();
  await expect(batch).not.toBeVisible();
  await expect(page.getByRole('cell', {name: 'Browser test lunch batch', exact: true})).toBeVisible();

  const after = await snapshot(page);
  expect(after.inventory.find(item => item.id === 'b1-prepared-m1')!.quantity)
    .toBe(before.inventory.find(item => item.id === 'b1-prepared-m1')!.quantity + 2);
  expect(after.inventory.find(item => item.id === 'b1-rice')!.quantity)
    .toBeCloseTo(before.inventory.find(item => item.id === 'b1-rice')!.quantity + 1 - 0.4, 4);
  expect(after.inventory.find(item => item.id === 'b1-chicken')!.quantity)
    .toBeCloseTo(before.inventory.find(item => item.id === 'b1-chicken')!.quantity - 0.3, 4);
  expect(after.production.some(item => item.note === 'Browser test lunch batch' && item.quantity === 2)).toBeTruthy();
});

test('an unavailable hub retains the local draft and disables confirmation', async ({page}) => {
  await login(page);
  await page.getByRole('button', {name: 'Add Ceylon milk tea', exact: true}).click();
  await page.getByRole('button', {name: 'Takeaway', exact: true}).click();
  // A hub refresh crosses the debounced local-save interval before a reload.
  await page.route('**/api/**', async route => {
    await new Promise(resolve => setTimeout(resolve, 350));
    await route.abort('connectionrefused');
  });
  await page.getByRole('button', {name: 'Refresh workspace', exact: true}).click();
  await expect(page.getByText('The branch hub is unavailable. Viewing saved data; new orders stay as drafts until you reconnect.')).toBeVisible();
  await page.reload();
  const order = page.locator('aside.order-panel');
  await expect(order.getByRole('heading', {name: 'Ceylon milk tea', exact: true})).toBeVisible();
  await expect(order.getByRole('button', {name: 'Charge order'})).toBeDisabled();
  await expect(order.getByRole('button', {name: 'Send to kitchen'})).toBeDisabled();
  await page.unroute('**/api/**');
  await page.getByRole('button', {name: 'Refresh workspace', exact: true}).click();
  await expect(order.getByRole('button', {name: 'Charge order'})).toBeEnabled();
  await expect(order.getByRole('heading', {name: 'Ceylon milk tea', exact: true})).toBeVisible();
});

test('phone navigation, order drawer and management pages fit a 390 px screen', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  const consoleErrors: string[] = [];
  page.on('console', message => {if (message.type() === 'error') consoleErrors.push(message.text());});
  await login(page);
  async function expectNoOverflow() {
    const size = await page.evaluate(() => ({document: document.documentElement.scrollWidth, viewport: window.innerWidth, page: location.hash}));
    expect(size.document, JSON.stringify(size)).toBeLessThanOrEqual(size.viewport + 1);
  }
  await expectNoOverflow();
  await page.getByRole('button', {name: 'Add Ceylon milk tea', exact: true}).click();
  await page.getByRole('button', {name: /^View order/}).click();
  await expect(page.getByRole('button', {name: 'Takeaway', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Takeaway', exact: true}).click();
  await expect(page.locator('aside.order-panel .order-total')).toContainText('Rs. 150.00');
  await page.getByRole('button', {name: 'Close order', exact: true}).click();
  for (const name of ['Kitchen display', 'Inventory', 'Production', 'Reports', 'Settings', 'Point of sale']) {
    await navigate(page, name);
    await expect(page.getByRole('heading', {level: 1})).toBeVisible();
    await expectNoOverflow();
  }
  expect(consoleErrors, 'Phone workflows should not log browser errors.').toEqual([]);
});

test('a static deployment explains a missing API without calling it a wrong PIN', async ({page}) => {
  await page.route('**/api/**', route => route.fulfill({status:404,contentType:'text/plain',body:'NOT_FOUND'}));
  await page.goto('/');
  await page.getByLabel('Staff PIN',{exact:true}).fill('1234');
  await page.getByRole('button', {name:'Open workspace',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('The POS backend is not connected to this website.');
});

test('Back closes one step and stays in the workspace at its first screen', async ({page}) => {
  await login(page);
  const stepBack=async()=>{
    await page.evaluate(()=>new Promise<void>(resolve=>{
      addEventListener('popstate',()=>requestAnimationFrame(()=>resolve()),{once:true});
      history.back();
    }));
  };
  await stepBack();
  await expect(page.getByRole('heading',{level:1,name:/Point of sale/})).toBeVisible();
  await navigate(page,'Products');
  await page.getByRole('button',{name:'Add product',exact:true}).click();
  const product=page.getByRole('dialog',{name:'Add product',exact:true});
  await expect(product).toBeVisible();
  await product.getByRole('button',{name:'Add category',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Add category',exact:true})).toBeVisible();
  await stepBack();
  await expect(page.getByRole('dialog',{name:'Add category',exact:true})).toHaveCount(0);
  await expect(product).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(product).toHaveCount(0);
  await expect(page.getByRole('heading',{level:1,name:/Products/})).toBeVisible();
  await stepBack();
  await expect(page.getByRole('heading',{level:1,name:/Point of sale/})).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Add Ceylon milk tea',exact:true}).click();
  await page.getByRole('button',{name:/^View order/}).click();
  await expect(page.getByRole('button',{name:'Close order',exact:true})).toBeVisible();
  await stepBack();
  await expect(page.getByRole('button',{name:'Close order',exact:true})).toBeHidden();
  await page.getByRole('button',{name:'Open navigation',exact:true}).click();
  await stepBack();
  await expect(page.locator('.sidebar')).toBeHidden();
  await page.getByRole('button',{name:/^View order/}).click();
  await expect(page.locator('aside.order-panel')).toContainText('Ceylon milk tea');
});

test('device text size, custom shortcuts and receipt millimetres persist and affect output', async ({page}) => {
  await login(page);
  await navigate(page,'Settings');
  const heading=page.getByRole('heading',{level:1});
  const baseSize=await heading.evaluate(element=>parseFloat(getComputedStyle(element).fontSize));
  await page.getByRole('slider',{name:'Font size',exact:true}).press('End');
  await expect.poll(()=>heading.evaluate(element=>parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(baseSize*1.4,1);
  await page.getByRole('textbox',{name:'Search products shortcut',exact:true}).press('F7');
  await expect(page.getByRole('textbox',{name:'Search products shortcut',exact:true})).toHaveValue('F7');
  await page.getByRole('button',{name:'58 mm',exact:true}).click();
  await page.getByRole('spinbutton',{name:'Content width (mm)',exact:true}).fill('50');
  await page.getByRole('spinbutton',{name:/^Horizontal offset \(mm\)/}).fill('1.5');
  await page.getByRole('button',{name:'Save for this device',exact:true}).click();
  await expect(page.getByText('Receipt layout saved for this device.',{exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByRole('slider',{name:'Font size',exact:true})).toHaveValue('140');
  await expect(page.getByRole('spinbutton',{name:'Paper width (mm)',exact:true})).toHaveValue('58');
  await page.keyboard.press('Alt+1');
  await page.keyboard.press('F7');
  await expect(page.getByRole('textbox',{name:'Search menu',exact:true})).toBeFocused();
  await page.keyboard.press('Alt+3');
  await expect(page.getByRole('heading',{level:1,name:/Sales history/})).toBeVisible();
  await page.getByRole('button',{name:'View receipt',exact:true}).first().click();
  await expect(page.getByRole('dialog',{name:'Order receipt',exact:true})).toBeVisible();
  await page.emulateMedia({media:'print'});
  const printed=await page.locator('.print-receipt').evaluate(element=>({width:element.getBoundingClientRect().width,left:element.getBoundingClientRect().left,scale:getComputedStyle(element).getPropertyValue('--font-scale')}));
  expect(printed.width).toBeCloseTo(50*96/25.4,0);
  expect(printed.left).toBeCloseTo((4+1.5)*96/25.4,0);
  expect(printed.scale.trim()).toBe('1');
  await page.emulateMedia({media:'screen'});
  await page.getByRole('dialog',{name:'Order receipt',exact:true}).getByRole('button',{name:'Close',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  for(const name of ['Settings','Products','Reports','Customers & dues','Day end & expenses','Held bills','Sales history','Point of sale']){
    await navigate(page,name);
    await expect(page.getByRole('heading',{level:1})).toBeVisible();
    const size=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth,page:location.hash}));
    expect(size.width,JSON.stringify(size)).toBeLessThanOrEqual(size.viewport+1);
  }
});

test('a POS category and barcoded product can be held, updated, sold on credit and collected', async ({page}) => {
  await login(page);
  const customerResponse=await page.request.post('/api/customers',{data:{commandId:crypto.randomUUID(),name:'Browser Credit Guest',phone:'0770001239',email:''}});
  expect(customerResponse.ok()).toBeTruthy();
  const {customer}=await customerResponse.json() as {customer:{id:string}};
  await page.getByRole('button',{name:'Refresh workspace',exact:true}).click();
  await page.getByRole('button',{name:'Add category',exact:true}).click();
  const category=page.getByRole('dialog',{name:'Add category',exact:true});
  await category.getByRole('textbox',{name:'Category name',exact:true}).fill('Browser specials');
  await category.getByRole('button',{name:'Add category',exact:true}).click();
  await expect(category).toHaveCount(0);
  await expect(page.getByRole('tab',{name:/^Browser specials/})).toHaveAttribute('aria-selected','true');
  await page.getByRole('button',{name:'Add product',exact:true}).click();
  const product=page.getByRole('dialog',{name:'Add product',exact:true});
  await product.getByRole('textbox',{name:'Product name',exact:true}).fill('Test snack pack');
  await expect(product.getByRole('combobox',{name:'Category',exact:true})).not.toHaveValue('');
  await product.getByRole('spinbutton',{name:'Selling price (LKR)',exact:true}).fill('15.25');
  await product.getByRole('spinbutton',{name:'Cost per unit (LKR)',exact:true}).fill('5');
  await product.getByRole('textbox',{name:'Barcode (optional)',exact:true}).fill('8940000123001');
  await product.getByRole('textbox',{name:'SKU (optional)',exact:true}).fill('TEST-PACK');
  await product.getByRole('spinbutton',{name:'Opening stock quantity',exact:true}).fill('8');
  await product.getByRole('button',{name:'Add product',exact:true}).click();
  await expect(product).toHaveCount(0);
  const saved=(await snapshot(page)).menu.find(item=>item.barcode==='8940000123001')!;
  expect(saved.categoryId).toBe((await snapshot(page)).categories.find(item=>item.name==='Browser specials')!.id);
  const search=page.getByRole('textbox',{name:'Search menu',exact:true});
  await search.fill('8940000123001');
  await search.press('Enter');
  const drawer=page.locator('aside.order-panel');
  await expect(drawer).toContainText('Test snack pack');
  await page.getByRole('button',{name:'Add one more Test snack pack',exact:true}).click();
  await page.getByRole('button',{name:'Takeaway',exact:true}).click();
  await page.getByRole('combobox',{name:'Select customer',exact:true}).selectOption(customer.id);
  const saveHold=async(label:string,update=false)=>{
    const action=update?'Update held bill':'Hold bill';
    await drawer.getByRole('button',{name:new RegExp(`^${action}`)}).click();
    const dialog=page.getByRole('dialog',{name:action,exact:true});
    await dialog.getByRole('textbox',{name:'Bill label',exact:true}).fill(label);
    await dialog.getByRole('button',{name:action,exact:true}).click();
    await expect(dialog).toHaveCount(0);
  };
  await saveHold('Browser held guest');
  const stock=async()=> (await snapshot(page)).inventory.find(item=>item.menuItemId===saved.id)!.quantity;
  expect(await stock()).toBe(8);
  await navigate(page,'Held bills');
  await page.getByRole('article').filter({hasText:'Browser held guest'}).getByRole('button',{name:'Resume bill',exact:true}).click();
  await expect(drawer).toContainText('Test snack pack');
  await expect(page.getByRole('combobox',{name:'Select customer',exact:true})).toHaveValue(customer.id);
  await page.getByRole('button',{name:'Add one more Test snack pack',exact:true}).click();
  await saveHold('Browser updated guest',true);
  const held=(await snapshot(page)).heldBills.filter(item=>item.label==='Browser updated guest');
  expect(held).toHaveLength(1);
  expect(held[0].lines[0].quantity).toBe(3);
  expect(await stock()).toBe(8);
  await navigate(page,'Held bills');
  await page.getByRole('article').filter({hasText:'Browser updated guest'}).getByRole('button',{name:'Resume bill',exact:true}).click();
  const createdResponse=mutation(page,'/api/orders');
  await drawer.getByRole('button',{name:'Charge order',exact:true}).click();
  const created=await createdResponse;
  expect(created.ok(),await created.text()).toBeTruthy();
  const {order}=await created.json() as {order:Order};
  const payment=page.getByRole('dialog',{name:'Take payment',exact:true});
  await payment.getByRole('button',{name:'Customer credit',exact:true}).click();
  await payment.getByRole('checkbox').check();
  await payment.getByRole('button',{name:'Confirm credit sale',exact:true}).click();
  const receipt=page.getByRole('dialog',{name:'Order receipt',exact:true});
  await expect(receipt).toBeVisible();
  await receipt.getByRole('button',{name:'Close',exact:true}).click();
  const sold=await snapshot(page);
  expect(sold.heldBills.some(item=>item.id===held[0].id)).toBeFalsy();
  expect(sold.orders.find(item=>item.id===order.id)!.payments[0].method).toBe('credit');
  expect(sold.creditEntries.find(item=>item.orderId===order.id)!.amount).toBe(4575);
  expect(await stock()).toBe(5);
  await navigate(page,'Products');
  await page.getByRole('searchbox',{name:'Search products',exact:true}).fill('8940000123001');
  await expect(page.getByRole('row').filter({hasText:'Test snack pack'})).toContainText('15.25');
  await navigate(page,'Customers & dues');
  await page.getByRole('row').filter({hasText:'Browser Credit Guest'}).getByRole('button',{name:'Ledger & collect',exact:true}).click();
  const ledger=page.getByRole('dialog',{name:'Customer ledger & collection',exact:true});
  await expect(ledger.getByRole('spinbutton',{name:'Amount received (LKR)',exact:true})).toHaveValue('45.75');
  await ledger.getByRole('textbox',{name:'Note (optional)',exact:true}).fill('Browser collection');
  await expect(ledger.getByRole('textbox',{name:'Note (optional)',exact:true})).toHaveValue('Browser collection');
  await expect(ledger.getByRole('spinbutton',{name:'Amount received (LKR)',exact:true})).toHaveValue('45.75');
  await ledger.getByRole('button',{name:'Record collection',exact:true}).click();
  await expect(ledger).toHaveCount(0);
  const collected=await snapshot(page);
  expect(collected.customers.find(item=>item.id===customer.id)!.balance).toBe(0);
  expect(collected.creditEntries.filter(item=>item.customerId===customer.id&&item.type==='collection')).toHaveLength(1);
  await navigate(page,'Reports');
  const downloadEvent=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download CSV',exact:true}).click();
  const download=await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/^demo-hotel-income-expenses-.*\.csv$/);
  const csv=await readFile((await download.path())!,'utf8');
  expect(csv).toContain('45.75');
  expect(csv).toContain('Browser collection');
  await navigate(page,'Day end & expenses');
  const dayEnd=page.waitForEvent('download');
  await page.getByRole('button',{name:'Day-end CSV',exact:true}).click();
  expect((await dayEnd).suggestedFilename()).toMatch(/^demo-hotel-day-end-.*\.csv$/);
});
