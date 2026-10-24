import {test,expect} from '@playwright/test';

test('a configured app opens cloud sign-in directly without a separate connection form',async({page})=>{
  await page.route('**/api/cloud?**',route=>{
    const action=new URL(route.request().url()).searchParams.get('action');
    return route.fulfill({json:action==='status'?{configured:true,missing:[]}:{authenticated:false}});
  });
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Sign in to your POS',exact:true})).toBeVisible();
  await expect(page.getByLabel('Cloud owner email',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Set up this device',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Connect this shop device',exact:true})).toHaveCount(0);
});

test('an interrupted cloud connection never silently switches a known cloud app to independent local sales',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('dh-cloud-configured','1'));
  await page.route('**/api/cloud?**',route=>route.fulfill({status:503,json:{error:'The cloud service is temporarily unavailable.'}}));
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Sign in to your POS',exact:true})).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  await expect(page.getByLabel('Staff PIN',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Set up this device',exact:true})).toHaveCount(0);
});
