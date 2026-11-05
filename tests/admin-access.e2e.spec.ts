import {test, expect, type Browser, type Page} from '@playwright/test';
import staticPlugin from '@fastify/static';
import {resolve} from 'node:path';
import {createApp} from '../server/app';
import {MemoryMonitorStore, recordKey, type Projection} from '../server/monitor/store';
import type {Order} from '../shared/types';

test.setTimeout(180_000);
test.use({actionTimeout: 15_000});
const staffPIN = '98765432';
const adminPIN = '0001';
const productName = 'Chicken rice & curry';
const productKey = recordKey('menu', 'm1');
const stockKey = recordKey('inventory', 'b1-prepared-m1');

async function openNavigation(page: Page) {
  const toggle = page.getByRole('button', {name: 'Open navigation', exact: true});
  if (await toggle.isVisible() && !await page.locator('.sidebar').evaluate(node => node.classList.contains('mobile-open'))) {
    await toggle.click();
  }
}

async function navigate(page: Page, name: string) {
  await openNavigation(page);
  await page.getByRole('navigation', {name: 'Main navigation'})
    .getByRole('button', {name: new RegExp(`^${name}`)}).click();
}

async function expectLocked(page: Page) {
  await openNavigation(page);
  await expect(page.getByRole('button', {name: 'Unlock admin access', exact: true})).toHaveCount(1);
  const navigation = page.getByRole('navigation', {name: 'Main navigation'});
  for (const name of ['Reports', 'Products', 'Inventory', 'Production', 'Purchases', 'Overview']) {
    await expect(navigation.getByRole('button', {name: new RegExp(`^${name}`)})).toHaveCount(0);
  }
  await expect(page.getByRole('button', {name: 'Add product', exact: true})).toHaveCount(0);
  await expect(page.getByRole('region', {name: 'Daily profitability', exact: true})).toHaveCount(0);
}

async function unlockDialog(page: Page) {
  await openNavigation(page);
  await page.getByRole('button', {name: 'Unlock admin access', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Unlock admin access', exact: true});
  await expect(dialog).toBeVisible();
  return dialog;
}

async function unlock(page: Page) {
  const dialog = await unlockDialog(page);
  await dialog.getByLabel('Admin PIN', {exact: true}).fill(adminPIN);
  await dialog.getByRole('button', {name: 'Unlock admin', exact: true}).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'Lock admin access', exact: true})).toHaveCount(1);
  await navigate(page, 'Point of sale');
}

async function lock(page: Page) {
  await openNavigation(page);
  await page.getByRole('button', {name: 'Lock admin access', exact: true}).click();
  await expectLocked(page);
  await navigate(page, 'Point of sale');
}

async function signIn(page: Page, origin: string) {
  await page.goto(origin);
  await page.getByLabel('Staff PIN', {exact: true}).fill(staffPIN);
  await page.getByRole('button', {name: 'Open workspace', exact: true}).click();
  await expect(page.getByRole('heading', {level: 1, name: /Point of sale/})).toBeVisible();
}

async function prepareServiceWorker(page: Page) {
  await page.evaluate(async () => {await navigator.serviceWorker.ready;});
  await page.reload();
  await expect(page.getByRole('heading', {level: 1, name: /Point of sale/})).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}

async function openSharedShop(browser: Browser) {
  const store = new MemoryMonitorStore();
  const app = await createApp({databasePath: ':memory:', seed: true, monitor: {store, env: {
    CLOUD_POS_PIN: staffPIN, CLOUD_ADMIN_PIN: adminPIN, CLOUD_SESSION_SECRET: 'a'.repeat(64),
  }}});
  await app.register(staticPlugin, {root: resolve('dist'), wildcard: false});
  const origin = await app.listen({host: '127.0.0.1', port: 0});
  const counter = await browser.newContext({viewport: {width: 1440, height: 1000}, serviceWorkers: 'allow'});
  const phone = await browser.newContext({viewport: {width: 390, height: 844}, serviceWorkers: 'allow'});
  const page = await counter.newPage();
  const remote = await phone.newPage();
  const errors: string[] = [];
  const adminRequests: string[] = [];
  for (const target of [page, remote]) {
    target.on('pageerror', error => errors.push(error.message));
    target.on('request', request => {
      if (new URL(request.url()).searchParams.get('action') === 'admin-unlock') adminRequests.push(request.url());
    });
  }
  try {
    await page.goto(`${origin}/?local=1`);
    await page.getByRole('button', {name: 'Set up this device', exact: true}).click();
    const setup = page.getByRole('dialog', {name: 'Set up this device', exact: true});
    await setup.getByLabel('Business name', {exact: true}).fill('Admin Access Hotel');
    await setup.getByLabel('Owner name', {exact: true}).fill('Counter Owner');
    await setup.getByLabel(/^Owner PIN/).fill(staffPIN);
    await setup.getByLabel('Confirm owner PIN', {exact: true}).fill(staffPIN);
    await setup.getByRole('checkbox', {name: /^Include sample menu/}).check();
    await setup.getByRole('button', {name: 'Create device workspace', exact: true}).click();
    await expect(page.getByRole('button', {name: `Add ${productName}`, exact: true})).toBeVisible();
    await signIn(page, origin);
    const source = (await store.list()).find(source => source.ready && source.shared)!;
    expect(source).toBeDefined();
    await expect(page).toHaveURL(new RegExp(`shared=${source.sourceId}`));
    await signIn(remote, origin);
    await prepareServiceWorker(page);
    await prepareServiceWorker(remote);
    await expectLocked(page);
    await expectLocked(remote);
    return {store, app, origin, counter, phone, page, remote, source, errors, adminRequests};
  } catch (error) {
    await counter.close();
    await phone.close();
    await app.close();
    throw error;
  }
}

async function cashSale(page: Page) {
  await navigate(page, 'Point of sale');
  await page.getByRole('button', {name: `Add ${productName}`, exact: true}).click();
  const view = page.getByRole('button', {name: /^View order/});
  if (await view.isVisible()) await view.click();
  await page.getByRole('button', {name: 'Takeaway', exact: true}).click();
  await page.getByRole('button', {name: 'Charge order', exact: true}).click();
  const payment = page.getByRole('dialog', {name: 'Take payment', exact: true});
  await payment.getByRole('button', {name: 'Confirm payment', exact: true}).click();
  const receipt = page.getByRole('dialog', {name: 'Order receipt', exact: true});
  await expect(receipt).toContainText('PAID');
  const number = (await receipt.locator('.modal-header p').innerText()).trim();
  await receipt.getByRole('button', {name: 'Close', exact: true}).click();
  return number;
}

async function customerLoanAndCollection(page: Page) {
  await navigate(page, 'Point of sale');
  await page.getByRole('button', {name: 'Add Vegetable rice & curry', exact: true}).click();
  await page.getByRole('button', {name: 'Takeaway', exact: true}).click();
  await page.getByRole('button', {name: /^Customer Loan/}).click();
  const customer = page.getByRole('dialog', {name: 'Customer Loan', exact: true});
  const create = customer.getByRole('button', {name: 'New customer', exact: true});
  if (await create.isVisible()) await create.click();
  await customer.getByLabel('Customer name', {exact: true}).fill('Cashier Loan Guest');
  await customer.getByLabel('Phone number', {exact: true}).fill('0775566779');
  await customer.getByRole('button', {name: 'Continue to loan', exact: true}).click();
  const payment = page.getByRole('dialog', {name: 'Take payment', exact: true});
  await payment.getByRole('checkbox').check();
  await payment.getByRole('button', {name: 'Confirm customer loan', exact: true}).click();
  const receipt = page.getByRole('dialog', {name: 'Order receipt', exact: true});
  await expect(receipt).toContainText('CREDIT');
  await receipt.getByRole('button', {name: 'Close', exact: true}).click();
  await navigate(page, 'Customers & dues');
  const row = page.getByRole('row').filter({hasText: 'Cashier Loan Guest'});
  await expect(row).toContainText('420.00');
  await row.getByRole('button', {name: 'Ledger & collect', exact: true}).click();
  const ledger = page.getByRole('dialog', {name: 'Customer ledger & collection', exact: true});
  await ledger.getByLabel('Amount received (LKR)', {exact: true}).fill('100');
  await ledger.getByRole('button', {name: 'Record collection', exact: true}).click();
  await expect(ledger).toHaveCount(0);
  await expect(row).toContainText('320.00');
}

const productRow = (page: Page) => page.getByRole('row').filter({hasText: productName});
const paidOrders = (projection: Projection) => Object.values(projection.records)
  .filter(row => row.kind === 'order' && row.value.paymentStatus === 'paid').map(row => row.value as unknown as Order);

async function editProduct(page: Page) {
  await navigate(page, 'Products');
  await productRow(page).getByRole('button', {name: `Edit ${productName}`, exact: true}).click();
  return page.getByRole('dialog', {name: 'Edit product', exact: true});
}

async function metadata(page: Page, sourceId: string) {
  return page.evaluate(databaseName => new Promise<{key: string; value: any}[]>((resolve, reject) => {
    const opening = indexedDB.open(databaseName);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const database = opening.result;
      const transaction = database.transaction('metadata', 'readonly');
      const request = transaction.objectStore('metadata').getAll();
      transaction.oncomplete = () => {database.close(); resolve(request.result);};
      transaction.onabort = () => {database.close(); reject(transaction.error);};
    };
  }), `demo-hotel-cloud-${sourceId}`);
}

test('the admin PIN protects reports and edits, cashier loans still work, and price/photo edits preserve stock sold by another device', async ({browser}) => {
  const {store, app, counter, phone, page, remote, source, errors} = await openSharedShop(browser);
  try {
    for (const hash of ['reports', 'products', 'inventory']) {
      await page.evaluate(hash => {location.hash = hash;}, hash);
      await expect(page).toHaveURL(/#pos$/);
      await expectLocked(page);
    }
    await navigate(page, 'Day end & expenses');
    await expect(page.getByRole('heading', {level: 1, name: 'Cash shift', exact: true})).toBeVisible();
    await expect(page.getByRole('button', {name: 'Add expense', exact: true})).toHaveCount(0);
    await expect(page.getByRole('heading', {name: 'Cash shift history', exact: true})).toHaveCount(0);
    const cashNumber = await cashSale(page);
    await customerLoanAndCollection(page);
    await expect.poll(async () => Object.values((await store.get(source.sourceId))!.records)
      .find(row => row.kind === 'customer' && row.value.name === 'Cashier Loan Guest')?.value.balance).toBe(32000);
    expect(paidOrders((await store.get(source.sourceId))!).filter(order => order.number === cashNumber)).toHaveLength(1);
    await expectLocked(page);

    const denied = await unlockDialog(page);
    await denied.getByLabel('Admin PIN', {exact: true}).fill('1111');
    await denied.getByRole('button', {name: 'Unlock admin', exact: true}).click();
    await expect(denied.getByRole('alert')).toContainText('incorrect');
    await expectLocked(page);
    await denied.getByLabel('Admin PIN', {exact: true}).fill(adminPIN);
    await denied.getByRole('button', {name: 'Unlock admin', exact: true}).click();
    await expect(denied).toHaveCount(0);
    await navigate(page, 'Reports');
    await expect(page.getByRole('region', {name: 'Daily profitability', exact: true})).toBeVisible();
    await expect(page.getByRole('button', {name: 'Profit CSV', exact: true})).toBeVisible();

    const image = 'https://example.invalid/admin-chicken-rice.jpg';
    const edit = await editProduct(page);
    await edit.getByLabel('Selling price (LKR)', {exact: true}).fill('710');
    await edit.getByLabel('Photo URL', {exact: true}).fill(image);
    await edit.getByRole('checkbox', {name: /^Update branch stock count/}).check();
    await edit.getByRole('spinbutton', {name: /^Counted stock/}).fill('10');
    await edit.getByRole('button', {name: 'Save product', exact: true}).click();
    await expect(edit).toHaveCount(0);
    await expect.poll(async () => (await store.get(source.sourceId))!.records[stockKey].value.quantity).toBe(10);
    expect((await store.get(source.sourceId))!.records[productKey].value).toMatchObject({price: 71000, image});
    await page.reload();
    await expect(page.getByRole('heading', {level: 1, name: /Point of sale/})).toBeVisible();
    await expectLocked(page);

    await unlock(page);
    const concurrent = await editProduct(page);
    await concurrent.getByLabel('Selling price (LKR)', {exact: true}).fill('720');
    const nextImage = 'https://example.invalid/admin-chicken-rice-updated.jpg';
    await concurrent.getByLabel('Photo URL', {exact: true}).fill(nextImage);
    await remote.reload();
    await expect(remote.getByRole('heading', {level: 1, name: /Point of sale/})).toBeVisible();
    await expectLocked(remote);
    const remoteNumber = await cashSale(remote);
    await expect.poll(async () => (await store.get(source.sourceId))!.records[stockKey].value.quantity).toBe(9);
    // Let the open editor receive a newer stock snapshot while its untouched
    // count field still holds the value from when the dialog opened.
    await expect(productRow(page).locator('.product-stock strong')).toHaveText('9 portions', {timeout: 20_000});
    await concurrent.getByRole('button', {name: 'Save product', exact: true}).click();
    await expect(concurrent).toHaveCount(0);
    await expect.poll(async () => (await store.get(source.sourceId))!.records[productKey].value.price).toBe(72000);
    const final = (await store.get(source.sourceId))!;
    expect(final.records[productKey].value.image).toBe(nextImage);
    expect(final.records[stockKey].value.quantity).toBe(9);
    expect(paidOrders(final).filter(order => order.number === remoteNumber)).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    await counter.close(); await phone.close(); await app.close();
  }
});

test('a prepared device first unlocks admin offline, queues approved edits, relocks for billing, and syncs while the phone remains locked', async ({browser}) => {
  const {store, app, counter, phone, page, remote, source, errors, adminRequests} = await openSharedShop(browser);
  try {
    const before = (await store.get(source.sourceId))!;
    const config = (await metadata(page, source.sourceId)).find(row => row.key === 'adminAccess:configuration')?.value;
    expect(config).toMatchObject({enabled: true, offline: {v: 1, sourceId: source.sourceId}});
    expect(config.offline.ciphertext).toEqual(expect.any(String));
    expect(config.offline).not.toHaveProperty('grant');
    expect(adminRequests).toEqual([]);
    await counter.setOffline(true);
    await phone.setOffline(true);
    await page.reload();
    await remote.reload();
    await expect(page.getByRole('heading', {level: 1, name: /Point of sale/})).toBeVisible();
    await expect(remote.getByRole('heading', {level: 1, name: /Point of sale/})).toBeVisible();
    await expectLocked(page);
    await expectLocked(remote);
    await unlock(page);
    expect(adminRequests).toEqual([]);
    const edit = await editProduct(page);
    const image = 'https://example.invalid/offline-admin-chicken-rice.jpg';
    await edit.getByLabel('Selling price (LKR)', {exact: true}).fill('820');
    await edit.getByLabel('Photo URL', {exact: true}).fill(image);
    await edit.getByRole('checkbox', {name: /^Update branch stock count/}).check();
    await edit.getByRole('spinbutton', {name: /^Counted stock/}).fill('12');
    await edit.getByRole('button', {name: 'Save product', exact: true}).click();
    await expect(edit).toHaveCount(0);
    await expect(productRow(page).locator('.product-stock strong')).toHaveText('12 portions');
    const queuedAdmin = (await metadata(page, source.sourceId))
      .filter(row => row.key.startsWith('cloudOffline:outbox:'))
      .map(row => row.value.commit).filter(commit => ['/menu/m1', '/inventory/b1-prepared-m1'].includes(commit.path));
    expect(queuedAdmin.map(commit => commit.path).sort()).toEqual(['/inventory/b1-prepared-m1', '/menu/m1']);
    expect(queuedAdmin.every(commit => typeof commit.adminGrant === 'string' && commit.adminGrant.length > 0)).toBe(true);
    await lock(page);
    const number = await cashSale(page);
    await expectLocked(page);
    expect((await store.get(source.sourceId))!.records).toEqual(before.records);
    const approvedAfterLock = (await metadata(page, source.sourceId))
      .filter(row => row.key.startsWith('cloudOffline:outbox:'))
      .map(row => row.value.commit).filter(commit => ['/menu/m1', '/inventory/b1-prepared-m1'].includes(commit.path));
    expect(approvedAfterLock).toEqual(queuedAdmin);

    await counter.setOffline(false);
    await phone.setOffline(false);
    await expect.poll(async () => (await store.get(source.sourceId))!.records[stockKey].value.quantity, {timeout: 30_000}).toBe(11);
    await expect.poll(async () => (await metadata(page, source.sourceId))
      .filter(row => row.key.startsWith('cloudOffline:outbox:')).length, {timeout: 30_000}).toBe(0);
    const assertSaved = (projection: Projection) => {
      expect(projection.records[productKey].value).toMatchObject({price: 82000, image});
      expect(projection.records[stockKey].value.quantity).toBe(11);
      const orders = paidOrders(projection).filter(order => order.number === number);
      expect(orders).toHaveLength(1);
      expect(orders[0].payments).toEqual([expect.objectContaining({method: 'cash', amount: 82000})]);
      const adjustments = Object.values(projection.records).filter(row => row.kind === 'movement'
        && row.value.itemId === 'b1-prepared-m1' && row.value.type === 'adjustment');
      expect(adjustments).toHaveLength(1);
      expect(adjustments[0].value.quantity).toBe(12 - Number(before.records[stockKey].value.quantity));
    };
    assertSaved((await store.get(source.sourceId))!);
    expect((await metadata(page, source.sourceId)).find(row => row.key === 'cloudOffline:state')?.value.lastError).toBe('');
    await expectLocked(page);
    await remote.reload();
    await expect(remote.getByRole('heading', {level: 1, name: /Point of sale/})).toBeVisible();
    await expectLocked(remote);
    await unlock(remote);
    await navigate(remote, 'Products');
    await expect(productRow(remote)).toContainText('820.00');
    await expect(productRow(remote).locator('.product-stock strong')).toHaveText('11 portions');
    await navigate(remote, 'Reports');
    await expect(remote.getByRole('region', {name: 'Daily profitability', exact: true})).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', {level: 1, name: /Point of sale/})).toBeVisible();
    await expectLocked(page);
    assertSaved((await store.get(source.sourceId))!);
    expect(errors).toEqual([]);
  } finally {
    await counter.close(); await phone.close(); await app.close();
  }
});
