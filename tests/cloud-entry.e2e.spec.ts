import {test,expect} from '@playwright/test';

for(const [name,path] of [['a configured app overrides a saved hub preference','/'],['an old cloud restore link opens the same POS','/?cloud=1&restore=1']] as const){
  test(`${name} with one staff PIN and no cloud selection`,async({page})=>{
    const actions:string[]=[];
    await page.addInitScript(()=>{localStorage.setItem('dh-workspace-mode','hub');localStorage.setItem('dh-cloud-configured','0');});
    await page.route('**/api/cloud?**',route=>{
      const action=new URL(route.request().url()).searchParams.get('action')??'';
      actions.push(action);
      return route.fulfill({json:action==='status'?{configured:true,missing:[],posPinConfigured:true}:{authenticated:false}});
    });
    await page.goto(path);
    await expect(page.getByRole('heading',{name:'Welcome back.',exact:true})).toBeVisible();
    await expect(page.getByLabel('Staff PIN',{exact:true})).toBeVisible();
    await expect(page.getByLabel('Cloud owner email',{exact:true})).toHaveCount(0);
    await expect(page.getByRole('combobox',{name:'Cloud workspace',exact:true})).toHaveCount(0);
    await expect(page.getByRole('heading',{name:'Choose your cloud workspace',exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Set up this device',exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Explore demo workspace',exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Connect this shop device',exact:true})).toHaveCount(0);
    expect(actions).toContain('pos-session');
    expect(actions).not.toContain('session');
  });
}

test('an interrupted cloud connection never silently switches a known cloud app to independent local sales',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('dh-cloud-configured','1'));
  await page.route('**/api/cloud?**',route=>route.fulfill({status:503,json:{error:'The cloud service is temporarily unavailable.'}}));
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Let’s reconnect your workspace.',exact:true})).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  await expect(page.getByLabel('Staff PIN',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Set up this device',exact:true})).toHaveCount(0);
});
