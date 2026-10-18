import {test as base, expect, type Page} from '@playwright/test';
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
