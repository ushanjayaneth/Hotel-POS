import {test as base, expect, type Page} from '@playwright/test';
import type {CreditEntry, Customer, Order, Snapshot} from '../shared/types';

type Mode = 'hub' | 'device';
type Accounts = Pick<Snapshot, 'orders' | 'customers' | 'creditEntries'>;

const test = base.extend<{runtimeCheck: void}>({
  runtimeCheck: [async ({page}, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await use();
    expect(errors, 'Customer Loan should not cause uncaught browser errors.').toEqual([]);
  }, {auto: true}],
});

test.setTimeout(90_000);

async function login(page: Page, mode: Mode) {
  if (mode === 'device') await page.route('**/api/**', route => route.fulfill({status: 404, body: 'NOT_FOUND'}));
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

async function accounts(page: Page, mode: Mode): Promise<Accounts> {
  if (mode === 'hub') {
    const response = await page.request.get('/api/bootstrap?branchId=b1');
    expect(response.ok()).toBeTruthy();
    return response.json() as Promise<Accounts>;
  }
  const records = await page.evaluate(() => new Promise<{kind: string; value: unknown}[]>((resolve, reject) => {
    const opening = indexedDB.open('demo-hotel-local-workspace-v1');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const database = opening.result;
      const transaction = database.transaction('records', 'readonly');
      const request = transaction.objectStore('records').getAll();
      transaction.onabort = () => {database.close(); reject(transaction.error);};
      transaction.oncomplete = () => {database.close(); resolve(request.result);};
    };
  }));
  return {
    orders: records.filter(row => row.kind === 'order').map(row => row.value as Order),
    customers: records.filter(row => row.kind === 'customer').map(row => row.value as Customer),
    creditEntries: records.filter(row => row.kind === 'credit').map(row => row.value as CreditEntry),
  };
}

async function navigate(page: Page, name: string) {
  await page.getByRole('navigation', {name: 'Main navigation'})
    .getByRole('button', {name: new RegExp(`^${name}`)}).click();
}

async function addCustomer(page: Page, name: string, phone: string) {
  await page.getByRole('button', {name: 'Add customer', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Add customer', exact: true});
  await dialog.getByLabel('Customer name', {exact: true}).fill(name);
  await dialog.getByLabel('Phone number', {exact: true}).fill(phone);
  await dialog.getByRole('button', {name: 'Add customer', exact: true}).click();
  await expect(dialog).toHaveCount(0);
}

async function confirmLoan(page: Page, name: string) {
  const payment = page.getByRole('dialog', {name: 'Take payment', exact: true});
  await expect(payment).toContainText(name);
  await payment.getByRole('checkbox').check();
  await payment.getByRole('button', {name: 'Confirm customer loan', exact: true}).click();
  const receipt = page.getByRole('dialog', {name: 'Order receipt', exact: true});
  await expect(receipt).toBeVisible();
  await receipt.getByRole('button', {name: 'Close', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'A fresh start.', exact: true})).toBeVisible();
}

for (const mode of ['hub', 'device'] as const) {
  test(`${mode}: checkout adds a loan customer, reuses the saved account and accepts a partial repayment`, async ({page}) => {
    await login(page, mode);
    const name = `Checkout Loan Guest ${mode}`;
    const phone = '0774321123';
    const before = await accounts(page, mode);
    await expect(page.getByRole('combobox', {name: 'Select customer', exact: true})).toHaveValue('');
    await page.getByRole('button', {name: 'Add Chicken rice & curry', exact: true}).click();
    await page.getByRole('button', {name: 'Charge order', exact: true}).click();
    const payment = page.getByRole('dialog', {name: 'Take payment', exact: true});
    const loanMethod = payment.getByRole('button', {name: 'Customer Loan', exact: true});
    await expect(loanMethod).toBeEnabled();
    await loanMethod.click();

    const chooser = page.getByRole('dialog', {name: 'Customer Loan', exact: true});
    await chooser.getByRole('button', {name: 'New customer', exact: true}).click();
    await chooser.getByLabel('Customer name', {exact: true}).fill(name);
    await chooser.getByLabel('Phone number', {exact: true}).fill(phone);
    await chooser.getByRole('button', {name: 'Continue to loan', exact: true}).click();
    await expect(chooser).toHaveCount(0);
    await expect(payment).toContainText(phone);
    await expect(payment).toContainText('Current outstanding');
    await confirmLoan(page, name);

    const first = await accounts(page, mode);
    const customer = first.customers.find(item => item.name === name)!;
    expect(customer).toMatchObject({phone, balance: 65000});
    const previousOrderIds = new Set(before.orders.map(order => order.id));
    const firstOrder = first.orders.find(order => !previousOrderIds.has(order.id))!;
    expect(firstOrder.customerId).toBe(customer.id);
    expect(firstOrder.payments).toHaveLength(1);
    expect(firstOrder.payments[0]).toMatchObject({method: 'credit', amount: 65000});
    expect(first.creditEntries.filter(entry => entry.customerId === customer.id)).toEqual([
      expect.objectContaining({type: 'sale', orderId: firstOrder.id, amount: 65000}),
    ]);

    // The footer must offer existing accounts as well as adding a new borrower.
    await page.getByRole('button', {name: 'Add Ceylon milk tea', exact: true}).click();
    await page.locator('aside.order-panel').getByRole('button', {name: /^Customer Loan/}).click();
    await expect(chooser).toBeVisible();
    await chooser.getByRole('button', {name: 'Existing customer', exact: true}).click();
    await chooser.getByRole('combobox', {name: 'Customer account', exact: true}).selectOption(customer.id);
    await expect(chooser).toContainText(name);
    await expect(chooser).toContainText(phone);
    await expect(chooser).toContainText('650.00');
    await chooser.getByRole('button', {name: 'Continue to loan', exact: true}).click();
    await confirmLoan(page, name);
    const second = await accounts(page, mode);
    expect(second.customers.filter(item => item.name === name)).toHaveLength(1);
    expect(second.customers.find(item => item.id === customer.id)!.balance).toBe(80000);
    expect(second.creditEntries.filter(entry => entry.customerId === customer.id && entry.type === 'sale')
      .map(entry => entry.amount).sort((a, b) => a - b)).toEqual([15000, 65000]);

    await navigate(page, 'Customers & dues');
    const row = page.getByRole('row').filter({hasText: name});
    await row.getByRole('button', {name: 'Ledger & collect', exact: true}).click();
    const ledger = page.getByRole('dialog', {name: 'Customer ledger & collection', exact: true});
    await expect(ledger).toContainText('Chicken rice & curry');
    await expect(ledger).toContainText('Ceylon milk tea');
    await expect(ledger.getByLabel('Amount received (LKR)', {exact: true})).toHaveValue('800');
    await ledger.getByLabel('Amount received (LKR)', {exact: true}).fill('200');
    await ledger.getByRole('button', {name: 'Record collection', exact: true}).click();
    await expect(ledger).toHaveCount(0);
    await expect(row).toContainText('600.00');
    const collected = await accounts(page, mode);
    expect(collected.customers.find(item => item.id === customer.id)!.balance).toBe(60000);
    expect(collected.creditEntries.filter(entry => entry.customerId === customer.id && entry.type === 'collection'))
      .toEqual([expect.objectContaining({amount: 20000})]);
  });

  test(`${mode}: a preselected customer can be changed before a loan and again at payment`, async ({page}) => {
    await login(page, mode);
    const firstName = `First Loan Guest ${mode}`;
    const secondName = `Second Loan Guest ${mode}`;
    await addCustomer(page, firstName, '0774321124');
    await addCustomer(page, secondName, '0774321125');
    const customers = (await accounts(page, mode)).customers;
    const first = customers.find(customer => customer.name === firstName)!;
    const second = customers.find(customer => customer.name === secondName)!;
    await page.getByRole('combobox', {name: 'Select customer', exact: true}).selectOption(first.id);
    await page.getByRole('button', {name: 'Add Ceylon milk tea', exact: true}).click();
    await page.locator('aside.order-panel').getByRole('button', {name: /^Customer Loan/}).click();
    const chooser = page.getByRole('dialog', {name: 'Customer Loan', exact: true});
    await expect(chooser).toBeVisible();
    await expect(chooser.getByRole('combobox', {name: 'Customer account', exact: true})).toHaveValue(first.id);
    await chooser.getByRole('combobox', {name: 'Customer account', exact: true}).selectOption(second.id);
    await chooser.getByRole('button', {name: 'Continue to loan', exact: true}).click();
    const payment = page.getByRole('dialog', {name: 'Take payment', exact: true});
    await expect(payment).toContainText(secondName);
    await payment.getByRole('button', {name: 'Change customer', exact: true}).click();
    await chooser.getByRole('combobox', {name: 'Customer account', exact: true}).selectOption(first.id);
    await chooser.getByRole('button', {name: 'Continue to loan', exact: true}).click();
    await confirmLoan(page, firstName);
    const after = await accounts(page, mode);
    expect(after.customers.find(customer => customer.id === first.id)!.balance).toBe(15000);
    expect(after.customers.find(customer => customer.id === second.id)!.balance).toBe(0);
    expect(after.creditEntries.filter(entry => entry.customerId === second.id)).toHaveLength(0);
    expect(after.creditEntries.filter(entry => entry.customerId === first.id))
      .toEqual([expect.objectContaining({type: 'sale', amount: 15000})]);
  });

  test(`${mode}: cancelling the loan chooser keeps the saved bill recoverable without recording debt`, async ({page}) => {
    await login(page, mode);
    const before = await accounts(page, mode);
    await page.getByRole('button', {name: 'Add Ceylon milk tea', exact: true}).click();
    await page.getByRole('button', {name: 'Charge order', exact: true}).click();
    const payment = page.getByRole('dialog', {name: 'Take payment', exact: true});
    await payment.getByRole('button', {name: 'Customer Loan', exact: true}).click();
    const chooser = page.getByRole('dialog', {name: 'Customer Loan', exact: true});
    await expect(chooser).toBeVisible();
    await chooser.getByRole('button', {name: 'Cancel', exact: true}).click();
    await expect(chooser).toHaveCount(0);
    await expect(payment).toBeVisible();
    await payment.getByRole('button', {name: 'Cancel', exact: true}).click();
    await expect(payment).toHaveCount(0);

    const after = await accounts(page, mode);
    const prior = new Set(before.orders.map(order => order.id));
    const created = after.orders.filter(order => !prior.has(order.id));
    expect(created).toHaveLength(1);
    const order = created[0];
    expect(order).toMatchObject({customerId: null, paymentStatus: 'unpaid', paid: 0, total: 15000});
    expect(order.payments).toHaveLength(0);
    expect(after.creditEntries).toEqual(before.creditEntries);
    expect(after.customers).toEqual(before.customers);
    await navigate(page, 'Orders');
    await page.getByRole('textbox', {name: 'Search orders', exact: true}).fill(order.number);
    const card = page.getByRole('article').filter({has: page.getByRole('heading', {name: order.number, exact: true})});
    await card.getByRole('button', {name: 'Take payment', exact: true}).click();
    await expect(payment).toContainText('150.00');
    await expect(payment.getByRole('button', {name: 'Customer Loan', exact: true})).toBeEnabled();
    await payment.getByRole('button', {name: 'Customer Loan', exact: true}).click();
    await expect(chooser).toBeVisible();
  });
}
