import {test as base, expect, type Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import type {Order, Snapshot} from '../shared/types';

const test = base.extend<{runtimeCheck: void}>({
  runtimeCheck: [async ({page}, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await use();
    expect(errors, 'Saving a loan customer should not cause uncaught browser errors.').toEqual([]);
  }, {auto: true}],
});

test.setTimeout(90_000);

async function snapshot(page: Page): Promise<Snapshot> {
  const response = await page.request.get('/api/bootstrap?branchId=b1');
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<Snapshot>;
}

async function browserBack(page: Page) {
  // Wait for the actual traversal and all synchronous navigation handlers.
  return page.evaluate(() => new Promise<{kind: string; layerId?: string}>(resolve => {
    window.addEventListener('popstate', () => {
      queueMicrotask(() => resolve({kind: history.state?.kind, layerId: history.state?.layerId}));
    }, {once: true});
    history.back();
  }));
}

test('browser Back remains blocked while a loan customer is being saved, then payment can resume safely', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Explore demo workspace', exact: true}).click();
  await expect(page.getByRole('heading', {level: 1, name: /Point of sale/})).toBeVisible();
  await page.getByRole('button', {name: 'Add Ceylon milk tea', exact: true}).click();
  const orderResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/orders' && response.request().method() === 'POST');
  await page.getByRole('button', {name: 'Charge order', exact: true}).click();
  const createdResponse = await orderResponse;
  expect(createdResponse.ok()).toBeTruthy();
  const {order} = await createdResponse.json() as {order: Order};
  const payment = page.getByRole('dialog', {name: 'Take payment', exact: true});
  await payment.getByRole('button', {name: 'Customer Loan', exact: true}).click();
  const chooser = page.getByRole('dialog', {name: 'Customer Loan', exact: true});
  await chooser.getByRole('button', {name: 'New customer', exact: true}).click();
  const name = `Back guard customer ${randomUUID()}`;
  const phone = `077${Date.now().toString().slice(-7)}`;
  await chooser.getByLabel('Customer name', {exact: true}).fill(name);
  await chooser.getByLabel('Phone number', {exact: true}).fill(phone);
  const before = await snapshot(page);

  let releaseRequest!: () => void;
  const requestGate = new Promise<void>(resolve => {releaseRequest = resolve;});
  let requestIntercepted!: () => void;
  const intercepted = new Promise<void>(resolve => {requestIntercepted = resolve;});
  await page.route('**/api/customers', async route => {
    if (route.request().method() === 'POST') {
      requestIntercepted();
      await requestGate;
    }
    await route.continue();
  });

  try {
    await chooser.getByRole('button', {name: 'Continue to loan', exact: true}).click();
    await intercepted;
    await expect(chooser.getByRole('button', {name: 'Saving customer…', exact: true})).toBeDisabled();
    await expect(chooser.getByLabel('Customer name', {exact: true})).toBeDisabled();
    await expect(chooser.getByLabel('Phone number', {exact: true})).toBeDisabled();
    const layer = await page.evaluate(() => ({kind: history.state?.kind, layerId: history.state?.layerId}));
    expect(layer.kind).toBe('layer');
    expect(layer.layerId).toEqual(expect.any(String));

    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await browserBack(page)).toEqual(layer);
      await expect(chooser).toBeVisible();
      await expect(chooser.getByRole('button', {name: 'Saving customer…', exact: true})).toBeDisabled();
      await expect(chooser.getByLabel('Customer name', {exact: true})).toHaveValue(name);
    }
  } finally {
    releaseRequest();
  }

  await expect(chooser).toHaveCount(0);
  await expect(payment).toBeVisible();
  await expect(payment).toContainText(name);
  await expect(payment.getByRole('button', {name: 'Confirm customer loan', exact: true})).toBeDisabled();
  await payment.getByRole('button', {name: 'Cancel', exact: true}).click();
  const after = await snapshot(page);
  expect(after.customers.filter(customer => customer.name === name)).toEqual([
    expect.objectContaining({name, phone, balance: 0}),
  ]);
  expect(after.creditEntries).toEqual(before.creditEntries);
  expect(after.orders.find(saved => saved.id === order.id)).toMatchObject({
    customerId: null, paid: 0, paymentStatus: 'unpaid', payments: [],
  });
});
