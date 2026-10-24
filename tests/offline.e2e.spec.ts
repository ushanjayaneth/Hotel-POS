import {test as base, expect, type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import type {InventoryItem, MenuItem, Order} from '../shared/types';
import type {MediaRecord} from '../shared/media';
import type {LocalCredential, LocalJournal, LocalMetadata, LocalRecord, LocalSession} from '../src/lib/local/db';
import type {LocalWorkspaceInfo} from '../src/lib/local/types';
import type {BackupPayload} from '../src/lib/local/backup';
import {decryptDeviceBackup} from '../src/lib/local/backup-crypto';

const fixturePin = '98765432';
const businessName = 'Offline Browser Hotel';
const backupPassword = 'offline-backup-test-password';
const persistenceCounter = 'offline-e2e-persistence-requests';

const test = base.extend<{runtimeCheck: void}>({
  runtimeCheck: [async ({page}, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await use();
    expect(errors, 'Device workflows should not encounter uncaught browser errors.').toEqual([]);
  }, {auto: true}],
});

// These tests exercise the built app's actual service worker and IndexedDB.
// Playwright supplies a fresh browser context for each test.
test.use({serviceWorkers: 'allow'});
test.setTimeout(90_000);

async function rows<T>(page: Page, store: string): Promise<T[]> {
  return page.evaluate(storeName => new Promise<unknown[]>((resolve, reject) => {
    const opening = indexedDB.open('demo-hotel-local-workspace-v1');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const database = opening.result;
      const transaction = database.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).getAll();
      request.onerror = () => reject(request.error);
      transaction.onabort = () => { database.close(); reject(transaction.error); };
      transaction.oncomplete = () => { database.close(); resolve(request.result); };
    };
  }), store) as Promise<T[]>;
}

async function records<T>(page: Page, kind: string): Promise<T[]> {
  return (await rows<LocalRecord>(page, 'records')).filter(row => row.kind === kind).map(row => row.value as T);
}

async function workspace(page: Page): Promise<LocalWorkspaceInfo> {
  return (await rows<LocalMetadata>(page, 'metadata')).find(row => row.key === 'workspace')!.value as LocalWorkspaceInfo;
}

async function navigate(page: Page, name: string) {
  await page.getByRole('navigation', {name: 'Main navigation'})
    .getByRole('button', {name: new RegExp(`^${name}`)}).click();
}

async function setupWithoutBackend(page: Page) {
  const apiRequests: string[] = [];
  await page.route('**/api/**', route => {
    apiRequests.push(new URL(route.request().url()).pathname);
    return route.fulfill({status: 404, contentType: 'text/plain', body: 'NOT_FOUND'});
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator.storage, 'persist', {
      configurable: true,
      value: async () => {
        const key = 'offline-e2e-persistence-requests';
        localStorage.setItem(key, String(Number(localStorage.getItem(key) || 0) + 1));
        return false;
      },
    });
    Object.defineProperty(navigator.storage, 'persisted', {configurable: true, value: async () => false});
  });
  // Independent offline mode is explicit; the normal configured address opens cloud POS.
  await page.goto('/?local=1');
  await page.getByRole('button', {name: 'Set up this device', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Set up this device', exact: true});
  await dialog.getByLabel('Business name', {exact: true}).fill(businessName);
  await dialog.getByLabel('Owner name', {exact: true}).fill('Offline Test Owner');
  await dialog.getByLabel(/^Owner PIN/).fill(fixturePin);
  await dialog.getByLabel('Confirm owner PIN', {exact: true}).fill(fixturePin);
  await dialog.getByRole('checkbox', {name: /^Include sample menu and stock/}).check();
  await dialog.getByRole('button', {name: 'Create device workspace', exact: true}).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', {level: 1, name: /Point of sale/})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Add Chicken rice & curry', exact: true})).toBeVisible();
  // An initial hub session probe may receive the static host's 404. Once device
  // setup finishes, every business operation must stay inside the browser.
  apiRequests.length = 0;
  return apiRequests;
}

async function cacheAppAndGoOffline(page: Page) {
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await expect(page.getByRole('button', {name: 'Sign out', exact: true})).toBeVisible();
  await page.context().setOffline(true);
  // A successful document reload demonstrates that the app shell is cached.
  await page.reload();
  await expect(page.getByRole('button', {name: 'Sign out', exact: true})).toBeVisible();
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
}

async function loginWithSavedPin(page: Page) {
  await expect(page.getByRole('dialog', {name: 'Set up this device', exact: true})).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'Set up this device', exact: true})).toHaveCount(0);
  await page.getByLabel('Staff PIN', {exact: true}).fill(fixturePin);
  await page.getByRole('button', {name: 'Open workspace', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Sign out', exact: true})).toBeVisible();
}

async function confirmCashPayment(page: Page, expectedNumber?: string) {
  const payment = page.getByRole('dialog', {name: 'Take payment', exact: true});
  await payment.getByRole('button', {name: 'Exact amount', exact: true}).click();
  await expect(payment.getByRole('spinbutton', {name: 'Cash received (LKR)', exact: true})).toHaveValue('650');
  await payment.getByRole('button', {name: 'Confirm payment', exact: true}).click();
  const receipt = page.getByRole('dialog', {name: 'Order receipt', exact: true});
  await expect(receipt).toBeVisible();
  await expect(receipt).toContainText('PAID');
  await expect(receipt).toContainText('Rs. 650.00');
  if (expectedNumber) await expect(receipt).toContainText(expectedNumber);
  await receipt.getByRole('button', {name: 'Close', exact: true}).click();
}

async function sellOneTakeaway(page: Page): Promise<Order> {
  await navigate(page, 'Point of sale');
  const existingIds = new Set((await records<Order>(page, 'order')).map(order => order.id));
  await page.getByRole('button', {name: 'Add Chicken rice & curry', exact: true}).click();
  await page.getByRole('button', {name: 'Takeaway', exact: true}).click();
  await page.getByRole('button', {name: 'Charge order', exact: true}).click();
  await confirmCashPayment(page);
  return (await records<Order>(page, 'order')).find(order => !existingIds.has(order.id))!;
}

test('device setup survives denied persistence and bills entirely offline after cached reloads', async ({page}) => {
  const apiRequests = await setupWithoutBackend(page);
  await expect(page.getByRole('article')).toHaveCount(12);
  const initialWorkspace = await workspace(page);
  expect(initialWorkspace).toMatchObject({version: 1, businessName, demo: true});
  expect((await rows<LocalMetadata>(page, 'metadata')).find(row => row.key === 'storagePersistenceAttempted')?.value).toBe(true);
  expect(await page.evaluate(key => localStorage.getItem(key), persistenceCounter)).toBe('1');
  const initialStock = (await records<InventoryItem>(page, 'inventory')).find(item => item.id === 'b1-prepared-m1')!;

  await cacheAppAndGoOffline(page);
  expect((await workspace(page)).workspaceId).toBe(initialWorkspace.workspaceId);
  await page.getByRole('button', {name: 'Add Chicken rice & curry', exact: true}).click();
  await page.getByRole('button', {name: 'Takeaway', exact: true}).click();
  await page.getByRole('button', {name: 'Send to kitchen', exact: true}).click();
  await expect.poll(async () => (await records<Order>(page, 'order')).length).toBe(1);
  const created = (await records<Order>(page, 'order'))[0];
  expect(created).toMatchObject({type: 'takeaway', tableId: null, status: 'new', paymentStatus: 'unpaid', total: 65000});

  await navigate(page, 'Kitchen display');
  const ticket = page.getByRole('article').filter({has: page.getByRole('heading', {name: created.number, exact: true})});
  await ticket.getByRole('button', {name: 'Start preparing', exact: true}).click();
  await ticket.getByRole('button', {name: 'Mark ready', exact: true}).click();
  await expect(ticket.getByRole('button', {name: 'Mark served', exact: true})).toBeVisible();
  await navigate(page, 'Orders');
  await page.getByRole('textbox', {name: 'Search orders', exact: true}).fill(created.number);
  await page.getByRole('article').filter({has: page.getByRole('heading', {name: created.number, exact: true})})
    .getByRole('button', {name: 'Take payment', exact: true}).click();
  await confirmCashPayment(page, created.number);

  const paid = (await records<Order>(page, 'order')).find(order => order.id === created.id)!;
  expect(paid).toMatchObject({status: 'ready', paymentStatus: 'paid', paid: 65000});
  expect(paid.payments).toHaveLength(1);
  expect(paid.payments[0]).toMatchObject({method: 'cash', amount: 65000, received: 65000, change: 0});
  await navigate(page, 'Kitchen display');
  await expect(ticket).toBeVisible();
  await ticket.getByRole('button', {name: 'Mark served', exact: true}).click();
  await expect(ticket).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', {level: 1, name: /On the pass/})).toBeVisible();
  const saved = (await records<Order>(page, 'order')).find(order => order.id === created.id)!;
  expect(saved).toMatchObject({number: created.number, status: 'completed', paymentStatus: 'paid', total: 65000});
  expect(saved.payments).toEqual(paid.payments);
  expect((await records<InventoryItem>(page, 'inventory')).find(item => item.id === initialStock.id)!.quantity).toBe(initialStock.quantity - 1);
  expect((await rows<LocalJournal>(page, 'journal')).some(entry => entry.action === `POST /orders/${created.id}/payments`)).toBe(true);

  await page.getByRole('button', {name: 'Sign out', exact: true}).click();
  await expect(page.getByLabel('Staff PIN', {exact: true})).toBeVisible();
  await page.reload();
  await loginWithSavedPin(page);
  expect(await workspace(page)).toEqual(initialWorkspace);
  expect(await page.evaluate(key => localStorage.getItem(key), persistenceCounter)).toBe('1');
  expect((await records<Order>(page, 'order')).filter(order => order.id === created.id)).toHaveLength(1);
  expect(apiRequests, 'Offline device billing and sign-in must never depend on a hosted API.').toEqual([]);
});

test('offline worker backups decrypt to real records and restore only after explicit replacement', async ({page}) => {
  const apiRequests = await setupWithoutBackend(page);
  await cacheAppAndGoOffline(page);
  const originalWorkspace = await workspace(page);
  const firstOrder = await sellOneTakeaway(page);
  expect(firstOrder.paymentStatus).toBe('paid');
  const stockAtBackup = (await records<InventoryItem>(page, 'inventory')).find(item => item.id === 'b1-prepared-m1')!.quantity;
  await navigate(page, 'Settings');
  await page.getByRole('button', {name: 'Export encrypted backup', exact: true}).click();
  const exportDialog = page.getByRole('dialog', {name: 'Export encrypted backup', exact: true});
  await exportDialog.getByLabel(/^Backup password/).fill(backupPassword);
  await exportDialog.getByLabel('Confirm backup password', {exact: true}).fill(backupPassword);
  const downloading = page.waitForEvent('download');
  await exportDialog.getByRole('button', {name: 'Download encrypted backup', exact: true}).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^demo-hotel-device-.*\.hotelbackup$/);
  const backupPath = (await download.path())!;
  const encryptedText = await readFile(backupPath, 'utf8');
  expect(encryptedText).not.toContain(businessName);
  const payload = await decryptDeviceBackup(encryptedText, backupPassword) as BackupPayload;
  expect(payload).toMatchObject({format: 'demo-hotel-device-data', version: 1});
  expect(payload.tables.records.find(row => row.kind === 'order' && row.id === firstOrder.id)?.value).toMatchObject({paymentStatus: 'paid', total: 65000});
  expect(payload.tables.records.find(row => row.kind === 'inventory' && row.id === 'b1-prepared-m1')?.value.quantity).toBe(stockAtBackup);
  expect(payload.tables.credentials).toHaveLength(1);
  expect(payload.tables.credentials[0].hash).toMatch(/^[a-f0-9]{64}$/);
  expect(payload.tables).not.toHaveProperty('sessions');
  await expect(exportDialog).toHaveCount(0);
  await expect.poll(async () => (await rows<LocalMetadata>(page, 'metadata')).find(row => row.key === 'lastBackup')?.value).toBeTruthy();

  const secondOrder = await sellOneTakeaway(page);
  expect(secondOrder.id).not.toBe(firstOrder.id);
  expect(await records<Order>(page, 'order')).toHaveLength(2);
  await navigate(page, 'Settings');
  await page.getByRole('button', {name: 'Restore backup', exact: true}).click();
  const restoreDialog = page.getByRole('dialog', {name: 'Restore encrypted backup', exact: true});
  await restoreDialog.getByLabel('Encrypted backup file', {exact: true}).setInputFiles(backupPath);
  await restoreDialog.getByLabel('Backup password', {exact: true}).fill(backupPassword);
  await restoreDialog.getByRole('button', {name: 'Review backup', exact: true}).click();
  await expect(restoreDialog.getByRole('heading', {name: businessName, exact: true})).toBeVisible();
  const replace = restoreDialog.getByRole('button', {name: 'Replace and restore', exact: true});
  await expect(replace).toBeDisabled();
  expect(await records<Order>(page, 'order')).toHaveLength(2);
  expect((await workspace(page)).deviceId).toBe(originalWorkspace.deviceId);
  await restoreDialog.getByRole('checkbox', {name: 'Replace the workspace stored on this device with this backup.', exact: true}).check();
  await expect(replace).toBeDisabled();
  await restoreDialog.getByLabel(`Type ${businessName} to confirm`, {exact: true}).fill(businessName);
  await expect(replace).toBeEnabled();
  await replace.click();
  await expect(page.getByLabel('Staff PIN', {exact: true})).toBeVisible();
  expect(await rows<LocalSession>(page, 'sessions')).toHaveLength(0);
  await loginWithSavedPin(page);

  const restoredWorkspace = await workspace(page);
  expect(restoredWorkspace.workspaceId).toBe(originalWorkspace.workspaceId);
  expect(restoredWorkspace.deviceId).not.toBe(originalWorkspace.deviceId);
  expect((await rows<LocalMetadata>(page, 'metadata')).find(row => row.key === 'restoredFromDeviceId')?.value).toBe(originalWorkspace.deviceId);
  const restoredOrders = await records<Order>(page, 'order');
  expect(restoredOrders).toHaveLength(1);
  expect(restoredOrders[0]).toEqual(firstOrder);
  expect(restoredOrders.some(order => order.id === secondOrder.id)).toBe(false);
  expect((await records<InventoryItem>(page, 'inventory')).find(item => item.id === 'b1-prepared-m1')!.quantity).toBe(stockAtBackup);
  expect(await rows<LocalCredential>(page, 'credentials')).toEqual(payload.tables.credentials);
  await page.reload();
  await expect(page.getByRole('button', {name: 'Sign out', exact: true})).toBeVisible();
  expect((await records<Order>(page, 'order'))[0].payments).toEqual(firstOrder.payments);
  expect(await page.evaluate(key => localStorage.getItem(key), persistenceCounter)).toBe('1');
  expect(apiRequests, 'Backup export, inspection, restore and PIN login must work without a hosted API.').toEqual([]);
});

test('offline product photos are compressed, survive reloads and retain sale-time profit', async ({page}) => {
  const apiRequests = await setupWithoutBackend(page);
  await cacheAppAndGoOffline(page);
  // Generate a large deterministic raster fixture in the browser so the upload
  // exercises native decoding, resizing and JPEG compression without a fixture file.
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 2048;
    const drawing = canvas.getContext('2d')!;
    const pixels = drawing.createImageData(canvas.width, canvas.height);
    let random = 123456789;
    for (let index = 0; index < pixels.data.length; index += 4) {
      random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
      pixels.data[index] = random & 255;
      pixels.data[index + 1] = (random >>> 8) & 255;
      pixels.data[index + 2] = (random >>> 16) & 255;
      pixels.data[index + 3] = 255;
    }
    drawing.putImageData(pixels, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const originalPhoto = Buffer.from(png, 'base64');
  expect(originalPhoto.length).toBeGreaterThan(700_000);

  await navigate(page, 'Products');
  await page.getByRole('button', {name: 'Add product', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Add product', exact: true});
  const productName = 'Offline photo snack';
  await dialog.getByRole('textbox', {name: 'Product name', exact: true}).fill(productName);
  await dialog.getByRole('combobox', {name: 'Category', exact: true}).selectOption('rice');
  await dialog.getByRole('spinbutton', {name: 'Selling price (LKR)', exact: true}).fill('350');
  await dialog.getByRole('spinbutton', {name: 'Cost per unit (LKR)', exact: true}).fill('200');
  await dialog.getByRole('textbox', {name: 'Barcode (optional)', exact: true}).fill('8940000000350');
  await dialog.getByRole('spinbutton', {name: 'Opening stock quantity', exact: true}).fill('8');
  await dialog.getByLabel('Upload product photo', {exact: true}).setInputFiles({name: 'large-product.png', mimeType: 'image/png', buffer: originalPhoto});
  const preview = dialog.locator('img[alt="Product photo preview"]');
  await expect(preview).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => preview.evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
  await dialog.getByRole('button', {name: 'Add product', exact: true}).click();
  await expect(dialog).toHaveCount(0);

  const product = (await records<MenuItem>(page, 'menu')).find(item => item.barcode === '8940000000350')!;
  expect(product.image).toMatch(/^local-image:media-/);
  const photo = (await records<MediaRecord>(page, 'media')).find(item => `local-image:${item.id}` === product.image)!;
  expect(photo.mime).toBe('image/jpeg');
  expect(photo.byteLength).toBeGreaterThan(0);
  expect(photo.byteLength).toBeLessThanOrEqual(700_000);
  expect(photo.byteLength).toBeLessThan(originalPhoto.length);
  expect(Math.max(photo.width, photo.height)).toBeLessThanOrEqual(1600);
  expect(Buffer.from(photo.data, 'base64').length).toBe(photo.byteLength);

  await navigate(page, 'Point of sale');
  const image = page.locator(`img[alt="${productName}"]`);
  await expect(image).toHaveAttribute('src', /^blob:/);
  await image.scrollIntoViewIfNeeded();
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true);
  await page.getByRole('button', {name: `Add ${productName}`, exact: true}).click();
  await page.getByRole('button', {name: 'Takeaway', exact: true}).click();
  await page.getByRole('button', {name: 'Charge order', exact: true}).click();
  const payment = page.getByRole('dialog', {name: 'Take payment', exact: true});
  await payment.getByRole('button', {name: 'Exact amount', exact: true}).click();
  await expect(payment.getByRole('spinbutton', {name: 'Cash received (LKR)', exact: true})).toHaveValue('350');
  await payment.getByRole('button', {name: 'Confirm payment', exact: true}).click();
  const receipt = page.getByRole('dialog', {name: 'Order receipt', exact: true});
  await expect(receipt).toContainText('PAID');
  await receipt.getByRole('button', {name: 'Close', exact: true}).click();
  const order = (await records<Order>(page, 'order'))[0];
  expect(order.lines[0]).toMatchObject({menuItemId: product.id, quantity: 1, unitPrice: 35000, unitCost: 20000});
  expect((await records<InventoryItem>(page, 'inventory')).find(item => item.menuItemId === product.id)!.quantity).toBe(7);

  await navigate(page, 'Reports');
  const profit = page.getByRole('region', {name: 'Daily profitability', exact: true});
  await expect(profit.locator('.profit-metrics > div').filter({hasText: 'Net food & product sales'})).toContainText('Rs. 350.00');
  await expect(profit.locator('.profit-metrics > div').filter({hasText: 'Cost of sales'})).toContainText('Rs. 200.00');
  await expect(profit.locator('.profit-metrics > div').filter({hasText: 'Gross profit'})).toContainText('Rs. 150.00');
  const profitRow = profit.getByRole('row').filter({hasText: productName});
  await expect(profitRow).toContainText('42.9%');
  const downloading = page.waitForEvent('download');
  await profit.getByRole('button', {name: 'Profit CSV', exact: true}).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^profit-CMB-.*\.csv$/);
  expect(await readFile((await download.path())!, 'utf8')).toContain(productName);

  await navigate(page, 'Point of sale');
  await page.reload();
  await expect(image).toHaveAttribute('src', /^blob:/);
  await image.scrollIntoViewIfNeeded();
  await expect.poll(() => image.evaluate((element, width) => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth === width, photo.width)).toBe(true);
  expect((await records<MediaRecord>(page, 'media')).find(item => item.id === photo.id)).toEqual(photo);
  await navigate(page, 'Reports');
  await expect(profit.locator('.profit-metrics > div').filter({hasText: 'Gross profit'})).toContainText('Rs. 150.00');
  expect(apiRequests, 'Offline photo upload, sales, reports and cached reloads must stay on this device.').toEqual([]);
});
