import {test, expect, type Page} from '@playwright/test';
import {createServer, type Server} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname, resolve, sep} from 'node:path';
import type {AddressInfo} from 'node:net';
import type {Customer, CreditEntry, InventoryItem, Order, Shift} from '../shared/types';
import type {Draft} from '../src/lib/db';

test.use({serviceWorkers: 'allow'});
test.setTimeout(90_000);

/** A separate static origin keeps real service-worker updates independent of the test hub. */
async function staticHost() {
  const directory = resolve('dist');
  const worker = await readFile(resolve(directory, 'sw.js'), 'utf8');
  let revision = 1;
  const workerRevisions: number[] = [];
  const mime: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json',
    '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  };
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = decodeURIComponent(new URL(request.url || '/', 'http://fixture').pathname);
      if (pathname.startsWith('/api/')) {response.writeHead(404);response.end('NOT_FOUND');return;}
      if (pathname === '/sw.js') {
        workerRevisions.push(revision);
        response.writeHead(200, {'Content-Type': mime['.js'], 'Cache-Control': 'no-store', 'Service-Worker-Allowed': '/'});
        response.end(`${worker}\n// Browser update fixture revision ${revision}\nself.addEventListener('message', event => {if(event.data?.type === 'UPDATE_FIXTURE_VERSION') event.ports[0]?.postMessage(${revision});});\n`);
        return;
      }
      const path = resolve(directory, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!path.startsWith(directory + sep)) {response.writeHead(403);response.end();return;}
      const contents = await readFile(path);
      response.writeHead(200, {'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache'});
      response.end(contents);
    })().catch(() => {if (!response.headersSent) response.writeHead(404);response.end('NOT_FOUND');});
  });
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {server.off('error', reject);accept();});
  });
  return {server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, workerRevisions, publish: () => {revision++;}};
}

async function close(server: Server) {
  await new Promise<void>((accept, reject) => {server.close(error => error ? reject(error) : accept());server.closeAllConnections();});
}

async function activeWorkerRevision(page: Page) {
  return page.evaluate(() => new Promise<number>((accept, reject) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {channel.port1.close();reject(new Error('Active worker did not report its fixture revision.'));}, 3000);
    channel.port1.onmessage = event => {clearTimeout(timeout);channel.port1.close();accept(Number(event.data));};
    navigator.serviceWorker.controller!.postMessage({type: 'UPDATE_FIXTURE_VERSION'}, [channel.port2]);
  }));
}

async function rows<T>(page: Page, databaseName: string, storeName: string): Promise<T[]> {
  return page.evaluate(({databaseName, storeName}) => new Promise<unknown[]>((accept, reject) => {
    const opening = indexedDB.open(databaseName);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const database = opening.result;
      const transaction = database.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).getAll();
      transaction.onabort = () => {database.close();reject(transaction.error);};
      transaction.oncomplete = () => {database.close();accept(request.result);};
    };
  }), {databaseName, storeName}) as Promise<T[]>;
}

async function businessRecords(page: Page) {
  const records = await rows<{kind: string;value: unknown}>(page, 'demo-hotel-local-workspace-v1', 'records');
  const kind = <T,>(name: string) => records.filter(record => record.kind === name).map(record => record.value as T);
  return {customers: kind<Customer>('customer'), orders: kind<Order>('order'), credits: kind<CreditEntry>('credit'), inventory: kind<InventoryItem>('inventory'), shifts: kind<Shift>('shift')};
}

async function openDeviceWorkspace(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole('button', {name: 'Set up this device', exact: true}).click();
  const setup = page.getByRole('dialog', {name: 'Set up this device', exact: true});
  await setup.getByLabel('Business name', {exact: true}).fill('Update Guard Hotel');
  await setup.getByLabel('Owner name', {exact: true}).fill('Update Guard Owner');
  await setup.getByLabel(/^Owner PIN/).fill('98765432');
  await setup.getByLabel('Confirm owner PIN', {exact: true}).fill('98765432');
  await setup.getByRole('checkbox', {name: /^Include sample menu and stock/}).check();
  await setup.getByRole('button', {name: 'Create device workspace', exact: true}).click();
  await expect(setup).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'Add Ceylon milk tea', exact: true})).toBeVisible();
  await page.evaluate(async () => {await navigator.serviceWorker.ready;});
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await expect(page.getByRole('button', {name: 'Add Ceylon milk tea', exact: true})).toBeVisible();
}

/** Hold actual IndexedDB commits open, rather than merely delaying a network response. */
async function holdWrites(page: Page, database: string, storeName: string) {
  await page.evaluate(({database, storeName}) => {
    const original = IDBObjectStore.prototype.put;
    const originalCommit = IDBTransaction.prototype.commit;
    const state = {active: true, started: 0};
    const target = window as typeof window & {releaseUpdateWrites?: () => void; updateWriteCount?: () => number};
    target.updateWriteCount = () => state.started;
    target.releaseUpdateWrites = () => {state.active = false;IDBObjectStore.prototype.put = original;IDBTransaction.prototype.commit = originalCommit;};
    IDBTransaction.prototype.commit = function(this: IDBTransaction) {if(state.active && this.db.name === database && this.objectStoreNames.contains(storeName)) return;return originalCommit.call(this);};
    IDBObjectStore.prototype.put = function(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      const request = original.apply(this, args);
      if (this.transaction.db.name === database && this.name === storeName && state.active) {
        state.started++;
        const store = this;
        const keepAlive = () => {
          if (!state.active) return;
          try {const pending = store.get('__update_test_keepalive__');pending.onsuccess = keepAlive;pending.onerror = keepAlive;} catch { /* Application deliberately aborted the transaction. */ }
        };
        keepAlive();
      }
      return request;
    };
  }, {database, storeName});
}

async function releaseWrites(page: Page) {
  await page.evaluate(() => (window as typeof window & {releaseUpdateWrites?: () => void}).releaseUpdateWrites?.());
}

async function failDraftWrites(page: Page) {
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    (window as typeof window & {restoreDraftWrites?: () => void}).restoreDraftWrites = () => {IDBObjectStore.prototype.put = original;};
    IDBObjectStore.prototype.put = function(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'drafts') throw new DOMException('Device storage is full.', 'QuotaExceededError');
      return original.apply(this, args);
    };
  });
}

async function restoreDraftWrites(page: Page) {
  await page.evaluate(() => (window as typeof window & {restoreDraftWrites?: () => void}).restoreDraftWrites?.());
}

test('a real PWA update opens a centered prompt automatically and updates on one click while preserving sales, loans, PIN access and the draft', async ({page}) => {
  const host = await staticHost();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(host.url);
    await page.getByRole('button', {name: 'Set up this device', exact: true}).click();
    const setup = page.getByRole('dialog', {name: 'Set up this device', exact: true});
    await setup.getByLabel('Business name', {exact: true}).fill('Update Test Hotel');
    await setup.getByLabel('Owner name', {exact: true}).fill('Update Test Owner');
    await setup.getByLabel(/^Owner PIN/).fill('98765432');
    await setup.getByLabel('Confirm owner PIN', {exact: true}).fill('98765432');
    await setup.getByRole('checkbox', {name: /^Include sample menu and stock/}).check();
    await setup.getByRole('button', {name: 'Create device workspace', exact: true}).click();
    await expect(setup).toHaveCount(0);
    await expect(page.getByRole('button', {name: 'Add Chicken rice & curry', exact: true})).toBeVisible();
    await page.evaluate(async () => {await navigator.serviceWorker.ready;});
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    expect(await activeWorkerRevision(page)).toBe(1);

    // Save real business activity before changing the service worker at this origin.
    await page.getByRole('button', {name: 'Add Chicken rice & curry', exact: true}).click();
    await page.locator('aside.order-panel').getByRole('button', {name: /^Customer Loan/}).click();
    const chooser = page.getByRole('dialog', {name: 'Customer Loan', exact: true});
    await chooser.getByRole('button', {name: 'New customer', exact: true}).click();
    await chooser.getByLabel('Customer name', {exact: true}).fill('Saved Update Customer');
    await chooser.getByLabel('Phone number', {exact: true}).fill('0773456789');
    await chooser.getByRole('button', {name: 'Continue to loan', exact: true}).click();
    const payment = page.getByRole('dialog', {name: 'Take payment', exact: true});
    await payment.getByRole('checkbox').check();
    await payment.getByRole('button', {name: 'Confirm customer loan', exact: true}).click();
    const receipt = page.getByRole('dialog', {name: 'Order receipt', exact: true});
    await expect(receipt).toBeVisible();
    await receipt.getByRole('button', {name: 'Close', exact: true}).click();
    await page.getByRole('button', {name: 'Add Ceylon milk tea', exact: true}).click();
    await expect.poll(async () => (await rows<Draft>(page, 'demo-hotel-device', 'drafts')).find(draft => draft.id === 'device:b1')?.lines).toEqual([
      expect.objectContaining({menuItemId: 'm9', quantity: 1}),
    ]);
    const before = await businessRecords(page);
    expect(before.orders).toHaveLength(1);
    expect(before.customers.find(customer => customer.name === 'Saved Update Customer')).toMatchObject({phone: '0773456789', balance: 65000});
    const draft = (await rows<Draft>(page, 'demo-hotel-device', 'drafts')).find(item => item.id === 'device:b1')!;
    let navigations = 0;
    page.on('request', request => {if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++;});

    host.publish();
    // Returning to the app checks for an update without finding a toolbar action.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const update = page.getByRole('dialog', {name: 'Update available', exact: true});
    await expect(update).toBeVisible();
    expect(host.workerRevisions).toContain(2);
    expect(navigations, 'Checking for updates must not reload active work automatically.').toBe(0);
    const desktop = page.viewportSize()!, desktopBox = (await update.boundingBox())!;
    expect(Math.abs(desktopBox.x + desktopBox.width / 2 - desktop.width / 2)).toBeLessThan(4);
    await expect.poll(async () => {const box = (await update.boundingBox())!;return Math.abs(box.y + box.height / 2 - desktop.height / 2);}).toBeLessThan(4);
    await page.setViewportSize({width: 390, height: 844});
    await expect.poll(async () => {
      const box = (await update.boundingBox())!;
      return box.x >= 0 && box.y >= 0 && box.x + box.width <= 391 && box.y + box.height <= 845;
    }).toBe(true);
    await update.getByRole('button', {name: 'Later', exact: true}).click();
    await expect(update).toHaveCount(0);
    const reminder = page.getByRole('button', {name: 'Update available', exact: true});
    await expect(reminder).toBeVisible();
    await page.setViewportSize(desktop);
    await expect(page.locator('aside.order-panel')).toContainText('Ceylon milk tea');
    expect(navigations, 'Choosing Later must keep the current app and draft open.').toBe(0);
    await reminder.click();
    await expect(update).toBeVisible();
    await update.getByRole('button', {name: 'Update now', exact: true}).click();
    await expect.poll(() => navigations).toBe(1);
    await expect(page.getByRole('button', {name: 'Sign out', exact: true})).toBeVisible();
    expect(await activeWorkerRevision(page)).toBe(2);
    await expect(page.getByLabel('Staff PIN', {exact: true})).toHaveCount(0);
    await expect(update).toHaveCount(0);
    await expect(reminder).toHaveCount(0);
    await expect(page.locator('aside.order-panel')).toContainText('Ceylon milk tea');
    await expect(page.getByRole('combobox', {name: 'Select table', exact: true})).toHaveCount(0);
    expect(await businessRecords(page)).toEqual(before);
    expect((await rows<Draft>(page, 'demo-hotel-device', 'drafts')).find(item => item.id === 'device:b1')).toMatchObject({
      id: draft.id, lines: draft.lines, commandId: draft.commandId, type: draft.type, customerId: draft.customerId,
    });
    expect(errors).toEqual([]);
  } finally {await close(host.server);}
});

test('Update now stays open with a clear error for pending or failed draft commits and only reloads after an explicit successful retry', async ({page}) => {
  const host = await staticHost();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await openDeviceWorkspace(page, host.url);
    host.publish();
    await page.getByRole('button', {name: 'Refresh workspace', exact: true}).click();
    const update = page.getByRole('dialog', {name: 'Update available', exact: true});
    await expect(update).toBeVisible();
    await update.getByRole('button', {name: 'Later', exact: true}).click();
    const reminder = page.getByRole('button', {name: 'Update available', exact: true});
    let navigations = 0;
    page.on('request', request => {if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++;});
    await holdWrites(page, 'demo-hotel-device', 'drafts');
    await page.getByRole('button', {name: 'Add Ceylon milk tea', exact: true}).click();
    await expect.poll(() => page.evaluate(() => (window as typeof window & {updateWriteCount?: () => number}).updateWriteCount?.() || 0)).toBeGreaterThan(0);
    await reminder.click();
    await update.getByRole('button', {name: 'Update now', exact: true}).click();
    await expect(update.getByRole('button', {name: 'Updating…', exact: true})).toBeDisabled();
    await expect(update.getByRole('alert')).toContainText('The current draft is still saving.', {timeout: 15000});
    expect(navigations).toBe(0);
    await releaseWrites(page);
    await expect.poll(async () => (await rows<Draft>(page, 'demo-hotel-device', 'drafts')).find(draft => draft.id === 'device:b1')?.lines[0]?.quantity).toBe(1);
    expect(navigations, 'A timed-out attempt must not reload later when its old draft write finishes.').toBe(0);

    await update.getByRole('button', {name: 'Later', exact: true}).click();
    await failDraftWrites(page);
    await page.locator('aside.order-panel').getByRole('button', {name: 'Add one more Ceylon milk tea', exact: true}).click();
    await expect(page.getByRole('alert')).toContainText('This draft could not be saved');
    await reminder.click();
    await update.getByRole('button', {name: 'Update now', exact: true}).click();
    await expect(update.getByRole('alert')).toContainText('Reload stopped because the current draft could not be saved.');
    expect(navigations).toBe(0);
    await restoreDraftWrites(page);
    await update.getByRole('button', {name: 'Update now', exact: true}).click();
    await expect.poll(() => navigations).toBe(1);
    await expect(page.getByRole('button', {name: 'Sign out', exact: true})).toBeVisible();
    await expect(update).toHaveCount(0);
    await expect.poll(async () => (await rows<Draft>(page, 'demo-hotel-device', 'drafts')).find(draft => draft.id === 'device:b1')?.lines[0]?.quantity).toBe(2);
    await expect(page.locator('aside.order-panel')).toContainText('Ceylon milk tea');
    expect(errors).toEqual([]);
  } finally {
    await releaseWrites(page).catch(() => {});
    await restoreDraftWrites(page).catch(() => {});
    await close(host.server);
  }
});

test('activating an update in another tab never reloads a busy customer save, and that tab can apply it manually later', async ({page, context}) => {
  const host = await staticHost();
  let other: Page | undefined;
  const errors: string[] = [];
  try {
    await openDeviceWorkspace(page, host.url);
    other = await context.newPage();
    other.on('pageerror', error => errors.push(error.message));
    await other.goto(host.url);
    await other.getByLabel('Staff PIN', {exact: true}).fill('98765432');
    await other.getByRole('button', {name: 'Open workspace', exact: true}).click();
    await expect(other.getByRole('button', {name: 'Add Ceylon milk tea', exact: true})).toBeVisible();
    await expect.poll(() => other!.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    host.publish();
    await page.getByRole('button', {name: 'Refresh workspace', exact: true}).click();
    const update = page.getByRole('dialog', {name: 'Update available', exact: true});
    await expect(update).toBeVisible();
    await other.evaluate(() => window.dispatchEvent(new Event('focus')));
    const otherUpdate = other.getByRole('dialog', {name: 'Update available', exact: true});
    await expect(otherUpdate).toBeVisible();
    await otherUpdate.getByRole('button', {name: 'Later', exact: true}).click();

    await other.getByRole('button', {name: 'Add customer', exact: true}).click();
    const chooser = other.getByRole('dialog', {name: 'Add customer', exact: true});
    await chooser.getByLabel('Customer name', {exact: true}).fill('Customer saved across a tab update');
    await chooser.getByLabel('Phone number', {exact: true}).fill('0775432123');
    await holdWrites(other, 'demo-hotel-local-workspace-v1', 'records');
    await chooser.getByRole('button', {name: 'Add customer', exact: true}).click();
    await expect(chooser.getByRole('button', {name: 'Saving customer…', exact: true})).toBeDisabled();
    await expect.poll(() => other!.evaluate(() => (window as typeof window & {updateWriteCount?: () => number}).updateWriteCount?.() || 0)).toBeGreaterThan(0);
    let firstNavigations = 0;
    let otherNavigations = 0;
    page.on('request', request => {if (request.isNavigationRequest() && request.frame() === page.mainFrame()) firstNavigations++;});
    other.on('request', request => {if (request.isNavigationRequest() && request.frame() === other!.mainFrame()) otherNavigations++;});
    await update.getByRole('button', {name: 'Update now', exact: true}).click();
    await expect.poll(() => firstNavigations).toBe(1);
    expect(otherNavigations).toBe(0);
    await expect(otherUpdate, 'Activating a dismissed update in another tab must leave the active customer save usable.').toHaveCount(0);
    await expect(chooser.getByRole('button', {name: 'Saving customer…', exact: true})).toBeDisabled();
    await expect(chooser.getByLabel('Customer name', {exact: true})).toHaveValue('Customer saved across a tab update');
    await releaseWrites(other);
    await expect(chooser).toHaveCount(0);
    await expect.poll(async () => (await businessRecords(other!)).customers.filter(customer => customer.name === 'Customer saved across a tab update').length).toBe(1);
    expect(otherNavigations, 'Finishing a save in another tab must not schedule an automatic reload.').toBe(0);
    const before = await businessRecords(other);
    // A newer release may arrive before this tab reloads the already-activated
    // release. Update now must activate the new waiting worker in one attempt.
    expect(await activeWorkerRevision(other)).toBe(2);
    host.publish();
    await other.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(otherUpdate).toBeVisible();
    expect(host.workerRevisions).toContain(3);
    await otherUpdate.getByRole('button', {name: 'Update now', exact: true}).click();
    await expect.poll(() => otherNavigations).toBe(1);
    await expect(other.getByRole('button', {name: 'Sign out', exact: true})).toBeVisible();
    expect(await activeWorkerRevision(other)).toBe(3);
    expect(await businessRecords(other)).toEqual(before);
    expect(errors).toEqual([]);
  } finally {
    if (other) await releaseWrites(other).catch(() => {});
    await close(host.server);
  }
});
