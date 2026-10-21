import {test as base, expect, type Page} from '@playwright/test';
import type {DiningTable, HeldBill, Order, Snapshot} from '../shared/types';
import type {Draft} from '../src/lib/db';

type Mode = 'hub' | 'device';

const test = base.extend<{runtimeCheck: void}>({
  runtimeCheck: [async ({page}, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await use();
    expect(errors, 'Table-free sales should not encounter uncaught browser errors.').toEqual([]);
  }, {auto: true}],
});

test.setTimeout(90_000);

async function readStore<T>(page: Page, databaseName: string, storeName: string): Promise<T[]> {
  return page.evaluate(({databaseName, storeName}) => new Promise<unknown[]>((resolve, reject) => {
    const opening = indexedDB.open(databaseName);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const database = opening.result;
      const transaction = database.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).getAll();
      transaction.onabort = () => { database.close(); reject(transaction.error); };
      transaction.oncomplete = () => { database.close(); resolve(request.result); };
    };
  }), {databaseName, storeName}) as Promise<T[]>;
}

async function business(page: Page, mode: Mode) {
  if (mode === 'hub') {
    const response = await page.request.get('/api/bootstrap?branchId=b1');
    expect(response.ok()).toBeTruthy();
    return response.json() as Promise<Pick<Snapshot, 'orders' | 'tables' | 'heldBills'>>;
  }
  const records = await readStore<{kind: string; value: unknown}>(page, 'demo-hotel-local-workspace-v1', 'records');
  return {
    orders: records.filter(row => row.kind === 'order').map(row => row.value as Order),
    tables: records.filter(row => row.kind === 'table').map(row => row.value as DiningTable),
    heldBills: records.filter(row => row.kind === 'held').map(row => row.value as HeldBill),
  };
}

async function savedDraft(page: Page, mode: Mode) {
  const drafts = await readStore<Draft>(page, 'demo-hotel-device', 'drafts');
  return drafts.find(draft => draft.id === (mode === 'device' ? 'device:b1' : 'b1'));
}

async function navigate(page: Page, name: string) {
  await page.getByRole('navigation', {name: 'Main navigation'})
    .getByRole('button', {name: new RegExp(`^${name}`)}).click();
}

async function login(page: Page, mode: Mode) {
  if (mode === 'device') {
    await page.route('**/api/**', route => route.fulfill({status: 404, body: 'NOT_FOUND'}));
  }
  await page.goto('/');
  if (mode === 'hub') {
    await page.getByRole('button', {name: 'Explore demo workspace', exact: true}).click();
  } else {
    await page.getByRole('button', {name: 'Set up this device', exact: true}).click();
    const setup = page.getByRole('dialog', {name: 'Set up this device', exact: true});
    await setup.getByLabel(/^Owner PIN/).fill('98765432');
    await setup.getByLabel('Confirm owner PIN', {exact: true}).fill('98765432');
    await setup.getByRole('checkbox', {name: /^Include sample menu/}).check();
    await setup.getByRole('button', {name: 'Create device workspace', exact: true}).click();
  }
  await expect(page.getByRole('heading', {level: 1, name: /Point of sale/})).toBeVisible();
}

for (const mode of ['hub', 'device'] as const) {
  test(`${mode}: dine-in without a table survives reload and hold, takes payment and clears the cart`, async ({page}) => {
    await login(page, mode);
    const before = await business(page, mode);
    const originalTables = [...before.tables].sort((a, b) => a.id.localeCompare(b.id));
    const priorOrderIds = new Set(before.orders.map(order => order.id));
    const panel = page.locator('aside.order-panel');

    // Deliberately select Dine in. A Takeaway default must not hide this regression.
    await panel.getByRole('button', {name: 'Dine in', exact: true}).click();
    const table = panel.getByRole('combobox', {name: 'Select table', exact: true});
    await expect(table).toHaveValue('');
    await expect(table.getByRole('option', {name: 'No table (optional)', exact: true})).toHaveCount(1);
    await page.getByRole('button', {name: 'Add Cappuccino', exact: true}).click();
    await page.getByRole('button', {name: 'Add Watalappan', exact: true}).click();
    await panel.getByRole('button', {name: 'Add cart discount', exact: true}).click();
    const discount = page.getByRole('dialog', {name: 'Cart discount', exact: true});
    await discount.getByLabel('Discount amount (LKR)', {exact: true}).fill('50');
    await discount.getByRole('button', {name: 'Apply discount', exact: true}).click();
    await expect(panel.locator('.order-total')).toContainText('580.00');
    await expect.poll(async () => {
      const draft = await savedDraft(page, mode);
      return {type: draft?.type, tableId: draft?.tableId, discount: draft?.discount, lines: draft?.lines.length};
    }).toEqual({type: 'dine-in', tableId: '', discount: 5000, lines: 2});

    await page.reload();
    await expect(page.getByRole('heading', {level: 1, name: /Point of sale/})).toBeVisible();
    await expect(table).toHaveValue('');
    await expect(panel).toContainText('Cappuccino');
    await expect(panel).toContainText('Watalappan');
    await expect(panel.locator('.order-total')).toContainText('580.00');

    await panel.getByRole('button', {name: /^Hold bill/}).click();
    const heldLabel = `Table-free ${mode} guest`;
    const hold = page.getByRole('dialog', {name: 'Hold bill', exact: true});
    await hold.getByLabel('Bill label', {exact: true}).fill(heldLabel);
    await hold.getByRole('button', {name: 'Hold bill', exact: true}).click();
    await expect(hold).toHaveCount(0);
    const held = (await business(page, mode)).heldBills.find(bill => bill.label === heldLabel)!;
    expect(held).toMatchObject({type: 'dine-in', tableId: null, discount: 5000});
    expect(held.lines).toHaveLength(2);
    await navigate(page, 'Held bills');
    await page.getByRole('article').filter({has: page.getByRole('heading', {name: heldLabel, exact: true})})
      .getByRole('button', {name: 'Resume bill', exact: true}).click();
    await expect(table).toHaveValue('');
    await expect(panel.locator('.order-total')).toContainText('580.00');

    await panel.getByRole('button', {name: 'Charge order', exact: true}).click();
    const payment = page.getByRole('dialog', {name: 'Take payment', exact: true});
    await expect(payment).toBeVisible();
    await expect(page.getByText('Choose a table for this dine-in order.', {exact: true})).toHaveCount(0);
    await expect(payment).toContainText('dine in');
    await expect(payment.getByLabel('Cash received (LKR)', {exact: true})).toHaveValue('580');
    await payment.getByRole('button', {name: 'Confirm payment', exact: true}).click();
    const receipt = page.getByRole('dialog', {name: 'Order receipt', exact: true});
    await expect(receipt).toContainText('580.00');
    await expect(receipt).toContainText('dine in');
    await receipt.getByRole('button', {name: 'Close', exact: true}).click();
    await expect(page.getByRole('heading', {name: 'A fresh start.', exact: true})).toBeVisible();

    const after = await business(page, mode);
    const created = after.orders.filter(order => !priorOrderIds.has(order.id));
    expect(created).toHaveLength(1);
    const order = created[0];
    expect(order).toMatchObject({type: 'dine-in', tableId: null, total: 58000, paid: 58000, paymentStatus: 'paid', status: 'new'});
    expect(order.lines.map(line => line.name).sort()).toEqual(['Cappuccino', 'Watalappan']);
    expect(order.payments).toHaveLength(1);
    expect(order.payments[0]).toMatchObject({method: 'cash', amount: 58000});
    expect(after.heldBills.some(bill => bill.id === held.id && bill.status === 'held')).toBe(false);
    expect([...after.tables].sort((a, b) => a.id.localeCompare(b.id))).toEqual(originalTables);
    await expect.poll(async () => (await savedDraft(page, mode))?.lines.length).toBe(0);

    await navigate(page, 'Kitchen display');
    await expect(page.getByRole('article').filter({has: page.getByRole('heading', {name: order.number, exact: true})})).toBeVisible();
  });
}
