import {test, expect, type Page} from '@playwright/test';

test.setTimeout(120_000);

async function setup(page: Page) {
  // An isolated device workspace: this test never connects to a shop's cloud.
  await page.route('**/api/**', route => route.fulfill({status: 404, body: 'NOT_FOUND'}));
  await page.goto('/?local=1');
  await page.getByRole('button', {name: 'Set up this device', exact: true}).click();
  const setup = page.getByRole('dialog', {name: 'Set up this device', exact: true});
  await setup.getByLabel(/^Owner PIN/).fill('98765432');
  await setup.getByLabel('Confirm owner PIN', {exact: true}).fill('98765432');
  await setup.getByRole('checkbox', {name: /^Include sample menu/}).check();
  await setup.getByRole('button', {name: 'Create device workspace', exact: true}).click();
  await expect(page.getByRole('heading', {level: 1, name: /Point of sale/})).toBeVisible();
}

async function navigate(page: Page, name: string) {
  const menu = page.getByRole('button', {name: 'Open navigation', exact: true});
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('navigation', {name: 'Main navigation'})
    .getByRole('button', {name: new RegExp(`^${name}`)}).click();
}

async function fitsScreen(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => visualViewport?.scale ?? 1)).toBe(1);
  const undersizedInputs = await page.locator('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]),select,textarea').evaluateAll(
    controls => controls.filter(control => control.getBoundingClientRect().width > 0 && parseFloat(getComputedStyle(control).fontSize) < 16)
      .map(control => control.getAttribute('aria-label') ?? control.getAttribute('name') ?? control.tagName),
  );
  expect(undersizedInputs, 'Phone controls must not trigger focus zoom.').toEqual([]);
}

test('touch phone and tablet screens fit at every supported text size without hiding connection controls', async ({browser, baseURL}) => {
  const context = await browser.newContext({baseURL, viewport: {width: 320, height: 740}, isMobile: true, hasTouch: true, serviceWorkers: 'block'});
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await setup(page);
    for (const width of [320, 360, 390, 430, 768]) {
      await page.setViewportSize({width, height: 844});
      await fitsScreen(page);
      for (const selector of ['.cloud-dots', '.branch-picker', '.notification-button']) {
        const box = await page.locator(selector).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
      }
    }
    await page.setViewportSize({width: 320, height: 740});
    await navigate(page, 'Settings');
    await page.getByRole('slider', {name: 'Font size', exact: true}).press('End');
    await expect(page.getByRole('slider', {name: 'Font size', exact: true})).toHaveValue('140');
    for (const name of ['Settings', 'Products', 'Inventory', 'Production', 'Customers & dues', 'Reports', 'Point of sale']) {
      if (name !== 'Settings') await navigate(page, name);
      await fitsScreen(page);
    }
    await page.getByRole('textbox', {name: 'Search menu', exact: true}).tap();
    await fitsScreen(page);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('a small touchscreen completes a keypad sale and scrolls dialogs when the keyboard reduces screen height', async ({browser, baseURL}) => {
  const context = await browser.newContext({baseURL, viewport: {width: 320, height: 740}, isMobile: true, hasTouch: true, serviceWorkers: 'block'});
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await setup(page);
    await page.getByRole('button', {name: 'Add Ceylon milk tea', exact: true}).tap();
    await page.getByRole('button', {name: /^View order/}).tap();
    await page.getByRole('button', {name: 'Enter quantity for Ceylon milk tea', exact: true}).tap();
    const pad = page.getByRole('dialog', {name: 'Item quantity', exact: true});
    await pad.getByRole('button', {name: '2', exact: true}).tap();
    await pad.getByRole('button', {name: 'Apply', exact: true}).tap();
    await expect(page.locator('.order-total')).toContainText('300.00');
    await page.getByRole('button', {name: 'Charge order', exact: true}).tap();
    const payment = page.getByRole('dialog', {name: 'Take payment', exact: true});
    await expect(payment).toBeFocused();
    const cash = payment.getByLabel('Cash received (LKR)', {exact: true});
    await cash.tap();
    await page.setViewportSize({width: 320, height: 400});
    await cash.fill('500');
    await fitsScreen(page);
    const confirm = payment.getByRole('button', {name: 'Confirm payment', exact: true});
    await confirm.scrollIntoViewIfNeeded();
    const box = await confirm.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(400);
    await confirm.tap();
    const receipt = page.getByRole('dialog', {name: 'Order receipt', exact: true});
    await expect(receipt).toContainText('200.00');
    await receipt.getByRole('button', {name: 'Close', exact: true}).tap();
    await page.setViewportSize({width: 320, height: 740});
    const closeCart = page.getByRole('button', {name: 'Close order', exact: true});
    if (await closeCart.isVisible()) await closeCart.tap();
    await navigate(page, 'Products');
    await page.getByRole('button', {name: 'Add product', exact: true}).tap();
    const product = page.getByRole('dialog', {name: 'Add product', exact: true});
    await expect(product).toBeFocused();
    await product.getByLabel('Product name', {exact: true}).tap();
    await page.setViewportSize({width: 320, height: 400});
    await product.getByLabel('Product name', {exact: true}).fill('Touchscreen product');
    await product.getByRole('button', {name: 'Add category', exact: true}).tap();
    const category = page.getByRole('dialog', {name: 'Add category', exact: true});
    await expect(category).toBeFocused();
    await fitsScreen(page);
    await category.getByRole('button', {name: 'Close dialog', exact: true}).tap();
    await product.getByRole('button', {name: 'Close dialog', exact: true}).tap();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
