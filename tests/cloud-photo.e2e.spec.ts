import {test, expect, type Page} from '@playwright/test';
import staticPlugin from '@fastify/static';
import {resolve} from 'node:path';
import {createApp} from '../server/app';
import {MemoryMonitorStore} from '../server/monitor/store';
import type {MediaRecord} from '../shared/media';

test.setTimeout(120000);
const pin = '98765432';
async function signIn(page: Page) {
  await page.getByLabel('Staff PIN', {exact: true}).fill(pin);
  await page.getByRole('button', {name: 'Open workspace', exact: true}).click();
  await expect(page.getByRole('heading', {level: 1, name: /Point of sale/})).toBeVisible();
}
async function installedCache(page: Page) {
  await page.evaluate(async () => {await navigator.serviceWorker.ready;});
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}

test('camera and file product photos compress offline, survive reload and sync to a second phone', async ({browser}) => {
  const store = new MemoryMonitorStore();
  const app = await createApp({databasePath: ':memory:', seed: true, monitor: {store, env: {CLOUD_POS_PIN: pin, CLOUD_SESSION_SECRET: 'p'.repeat(64)}}});
  await app.register(staticPlugin, {root: resolve('dist'), wildcard: false});
  const origin = await app.listen({host: '127.0.0.1', port: 0});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, serviceWorkers: 'allow'});
  const phone = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, serviceWorkers: 'allow'});
  const page = await context.newPage(), remote = await phone.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message)); remote.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(origin); await signIn(page); await installedCache(page);
    const source = (await store.list()).find(row => row.ready && row.shared)!;
    expect(source).toBeDefined();
    await context.setOffline(true);
    await page.getByRole('button', {name: 'Add product', exact: true}).click();
    const dialog = page.getByRole('dialog', {name: 'Add product', exact: true});
    await dialog.getByLabel('Product name', {exact: true}).fill('Offline Photo Product');
    await dialog.getByRole('combobox', {name: /^Stock tracking/}).selectOption('untracked');
    await dialog.getByLabel('Selling price (LKR)', {exact: true}).fill('450');
    await dialog.getByLabel('Cost per unit (LKR)', {exact: true}).fill('200');
    const originals = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 1600;
      const ctx = canvas.getContext('2d')!, pixels = ctx.createImageData(1600, 1600);
      let random = 714027;
      for (let offset = 0; offset < pixels.data.length; offset += 4) {
        random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
        pixels.data[offset] = random & 255; pixels.data[offset + 1] = random >>> 8 & 255; pixels.data[offset + 2] = random >>> 16 & 255; pixels.data[offset + 3] = 255;
      }
      ctx.putImageData(pixels, 0, 0);
      return {png: canvas.toDataURL('image/png').split(',')[1], webp: canvas.toDataURL('image/webp', 0.99).split(',')[1], jpeg: canvas.toDataURL('image/jpeg', 0.97).split(',')[1]};
    });
    const preview = dialog.getByAltText('Product photo preview', {exact: true});
    for (const format of ['png', 'webp', 'jpeg'] as const) {
      const camera = format === 'jpeg';
      const choosing = page.waitForEvent('filechooser');
      await dialog.getByRole('button', {name: camera ? 'Take photo' : 'Choose photo', exact: true}).click();
      const chooser = await choosing;
      expect(await chooser.element().getAttribute('capture')).toBe(camera ? 'environment' : null);
      expect(await chooser.element().getAttribute('accept')).toBe(camera ? 'image/*' : 'image/jpeg,image/png,image/webp');
      const bytes = Buffer.from(originals[format], 'base64'); expect(bytes.length).toBeGreaterThan(1000000);
      await chooser.setFiles({name: `noisy-product.${format === 'jpeg' ? 'jpg' : format}`, mimeType: `image/${format}`, buffer: bytes});
      await expect(dialog.getByRole('button', {name: 'Choose photo', exact: true})).toBeEnabled();
      await expect(preview).toBeVisible();
      await expect.poll(() => preview.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    }
    await dialog.getByRole('button', {name: 'Add product', exact: true}).click();
    await expect(dialog).toHaveCount(0);
    const uploaded = await page.evaluate(async sourceId => new Promise<MediaRecord[]>((resolve, reject) => {
      const opening = indexedDB.open(`demo-hotel-cloud-${sourceId}`);
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const database = opening.result, transaction = database.transaction('records', 'readonly'), reading = transaction.objectStore('records').index('kind').getAll('media');
        transaction.oncomplete = () => {database.close(); resolve(reading.result.map((row: {value: MediaRecord}) => row.value));};
        transaction.onabort = () => {database.close(); reject(transaction.error);};
      };
    }), source.sourceId);
    expect(uploaded).toHaveLength(3);
    for (const photo of uploaded) {
      expect(photo.byteLength).toBeLessThanOrEqual(450000); expect(photo.byteLength).toBeGreaterThan(0);
      expect(photo.width).toBeGreaterThanOrEqual(240); expect(photo.width).toBeLessThanOrEqual(1600);
      expect(photo.height).toBe(photo.width); expect(photo.mime).toBe('image/jpeg');
      expect(Buffer.from(photo.data, 'base64').length).toBe(photo.byteLength);
    }
    await page.reload();
    const localPhoto = page.getByAltText('Offline Photo Product', {exact: true}).first();
    await expect(localPhoto).toBeVisible(); await expect.poll(() => localPhoto.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
    await context.setOffline(false);
    await expect.poll(async () => Object.values((await store.get(source.sourceId))!.records).some(row => row.kind === 'menu' && row.value.name === 'Offline Photo Product'), {timeout: 30000}).toBe(true);
    const mediaRequests: string[] = [];
    remote.on('request', request => {if (request.url().includes('action=media&')) mediaRequests.push(request.url());});
    await remote.goto(origin); await signIn(remote);
    const remotePhoto = remote.getByAltText('Offline Photo Product', {exact: true}).first();
    await expect(remotePhoto).toBeVisible(); await expect.poll(() => remotePhoto.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(mediaRequests.length).toBeGreaterThan(0);
    await remote.getByRole('button', {name: 'Add product', exact: true}).click();
    const phoneDialog = remote.getByRole('dialog', {name: 'Add product', exact: true});
    for (const name of ['Take photo', 'Choose photo']) {
      const button = phoneDialog.getByRole('button', {name, exact: true});
      await expect(button).toBeVisible();
      const bounds = await button.boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    }
    await phoneDialog.getByRole('button', {name: 'Close dialog', exact: true}).click();
    await installedCache(remote);
    await phone.setOffline(true); await remote.reload();
    const cachedPhoto = remote.getByAltText('Offline Photo Product', {exact: true}).first();
    await expect(cachedPhoto).toBeVisible(); await expect.poll(() => cachedPhoto.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally {await context.close(); await phone.close(); await app.close();}
});
