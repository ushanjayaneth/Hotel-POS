import type {Branch, Category, DiningTable, InventoryItem, MenuItem, Recipe, Settings, Shift, StaffMember, User} from '../../../shared/types.js';
import {localDb, LocalStore, type LocalDatabase} from './db.js';
import {createLocalCredential, loginLocal, prepareLocalSession, publicLocalUser, rememberLocalSession} from './auth.js';
import {localStorageError, now, requireLocal, uid, type LocalWorkspaceInfo} from './types.js';

export interface InitializeLocalWorkspaceInput {businessName: string; ownerName: string; pin: string; demo?: boolean}
export const localReceiptDefaults = {receiptPaperWidthMm: 80, receiptContentWidthMm: 72, receiptMarginMm: 2, receiptOffsetMm: 0, receiptFontSize: 10};
export async function getLocalWorkspaceInfo(db: LocalDatabase = localDb): Promise<LocalWorkspaceInfo | null> {
  return (await db.metadata.get('workspace'))?.value as LocalWorkspaceInfo | undefined ?? null;
}

const categories: Category[] = [
  {id: 'rice', name: 'Rice & curry', nameSi: 'Rice & curry', icon: 'rice'},
  {id: 'kottu', name: 'Kottu', nameSi: 'Kottu', icon: 'flame'},
  {id: 'noodles', name: 'Noodles', nameSi: 'Noodles', icon: 'noodles'},
  {id: 'short-eats', name: 'Short eats', nameSi: 'Short eats', icon: 'croissant'},
  {id: 'beverages', name: 'Beverages', nameSi: 'Beverages', icon: 'cup'},
  {id: 'desserts', name: 'Desserts', nameSi: 'Desserts', icon: 'cake'},
];
const demoMenu = (): MenuItem[] => [
  {id:'m1',name:'Chicken rice & curry',nameSi:'Chicken rice & curry',description:'Steamed samba rice, chicken curry and seasonal vegetables.',categoryId:'rice',price:65000,cost:27500,image:'/images/chicken-rice.jpg',available:true,stockMode:'prepared',badge:'Bestseller',preparationMinutes:5},
  {id:'m2',name:'Vegetable rice & curry',nameSi:'Vegetable rice & curry',description:'Samba rice, dhal, fresh mallung and vegetable curries.',categoryId:'rice',price:42000,cost:16000,image:'/images/veg-rice.jpg',available:true,stockMode:'prepared',badge:'Vegetarian',preparationMinutes:4},
  {id:'m3',name:'Chicken cheese kottu',nameSi:'Chicken cheese kottu',description:'Godamba roti, chicken, egg and melted cheese.',categoryId:'kottu',price:95000,cost:42000,image:'/images/kottu.jpg',available:true,stockMode:'recipe',badge:'Popular',preparationMinutes:12},
  {id:'m4',name:'Vegetable noodles',nameSi:'Vegetable noodles',description:'Wok-tossed noodles and crisp vegetables.',categoryId:'noodles',price:58000,cost:24000,image:'/images/noodles.jpg',available:true,stockMode:'recipe',preparationMinutes:10},
  {id:'m5',name:'Chicken biryani',nameSi:'Chicken biryani',description:'Basmati rice, spiced chicken and cooling raita.',categoryId:'rice',price:85000,cost:38000,image:'/images/biryani.jpg',available:true,stockMode:'prepared',preparationMinutes:6},
  {id:'m6',name:'Egg hopper',nameSi:'Egg hopper',description:'Coconut-milk hopper with egg and lunu miris.',categoryId:'short-eats',price:18000,cost:6500,image:'/images/hoppers.jpg',available:true,stockMode:'recipe',preparationMinutes:6},
  {id:'m7',name:'Vegetable samosa',nameSi:'Vegetable samosa',description:'Golden pastry with gently spiced vegetables.',categoryId:'short-eats',price:12000,cost:4500,image:'/images/samosa.jpg',available:true,stockMode:'prepared',preparationMinutes:2},
  {id:'m8',name:'Fresh lime juice',nameSi:'Fresh lime juice',description:'Freshly squeezed lime, sugar and ice.',categoryId:'beverages',price:28000,cost:8500,image:'/images/lime.jpg',available:true,stockMode:'recipe',preparationMinutes:3},
  {id:'m9',name:'Ceylon milk tea',nameSi:'Ceylon milk tea',description:'Ceylon tea with fresh milk.',categoryId:'beverages',price:15000,cost:5000,image:'/images/tea.jpg',available:true,stockMode:'recipe',preparationMinutes:3},
  {id:'m10',name:'Cappuccino',nameSi:'Cappuccino',description:'Espresso and silky steamed milk.',categoryId:'beverages',price:35000,cost:12500,image:'/images/coffee.jpg',available:true,stockMode:'recipe',preparationMinutes:4},
  {id:'m11',name:'Watalappan',nameSi:'Watalappan',description:'Coconut custard, kithul jaggery and cardamom.',categoryId:'desserts',price:28000,cost:10000,image:'/images/watalappan.jpg',available:true,stockMode:'prepared',preparationMinutes:1},
  {id:'m12',name:'Traditional rice & curry',nameSi:'Traditional rice & curry',description:'Sri Lankan rice plate with dhal and vegetable curries.',categoryId:'rice',price:78000,cost:34000,image:'/images/curry.jpg',available:true,stockMode:'prepared',preparationMinutes:5},
];
const demoIngredients = [
  {key:'rice',name:'Samba rice',unit:'kg',quantity:86,cost:24500},
  {key:'chicken',name:'Fresh chicken',unit:'kg',quantity:34,cost:130000},
  {key:'vegetables',name:'Mixed vegetables',unit:'kg',quantity:18,cost:38000},
  {key:'egg',name:'Farm eggs',unit:'pcs',quantity:180,cost:4500},
  {key:'roti',name:'Godamba roti',unit:'pcs',quantity:80,cost:6500},
  {key:'cheese',name:'Cheddar cheese',unit:'kg',quantity:3.4,cost:280000},
  {key:'noodles',name:'Egg noodles',unit:'kg',quantity:22,cost:68000},
  {key:'hopper',name:'Hopper batter',unit:'litre',quantity:15,cost:42000},
  {key:'lime',name:'Fresh lime',unit:'kg',quantity:8.2,cost:65000},
  {key:'sugar',name:'White sugar',unit:'kg',quantity:12,cost:30000},
  {key:'milk',name:'Fresh milk',unit:'litre',quantity:24,cost:52000},
  {key:'tea',name:'Ceylon tea',unit:'kg',quantity:4.5,cost:185000},
  {key:'coffee',name:'Ground coffee',unit:'kg',quantity:3,cost:320000},
];
const demoRecipes: Recipe[] = [
  {id:'m1',ingredients:[{key:'rice',quantity:.2},{key:'chicken',quantity:.15},{key:'vegetables',quantity:.15}]},
  {id:'m2',ingredients:[{key:'rice',quantity:.2},{key:'vegetables',quantity:.25}]},
  {id:'m3',ingredients:[{key:'roti',quantity:2},{key:'chicken',quantity:.12},{key:'egg',quantity:1},{key:'vegetables',quantity:.1},{key:'cheese',quantity:.05}]},
  {id:'m4',ingredients:[{key:'noodles',quantity:.2},{key:'vegetables',quantity:.12}]},
  {id:'m5',ingredients:[{key:'rice',quantity:.25},{key:'chicken',quantity:.2},{key:'vegetables',quantity:.1}]},
  {id:'m6',ingredients:[{key:'hopper',quantity:.12},{key:'egg',quantity:1}]},
  {id:'m8',ingredients:[{key:'lime',quantity:.1},{key:'sugar',quantity:.025}]},
  {id:'m9',ingredients:[{key:'tea',quantity:.006},{key:'milk',quantity:.1},{key:'sugar',quantity:.015}]},
  {id:'m10',ingredients:[{key:'coffee',quantity:.015},{key:'milk',quantity:.18},{key:'sugar',quantity:.02}]},
];

export async function initializeLocalWorkspace(input: InitializeLocalWorkspaceInput, db: LocalDatabase = localDb): Promise<{user: User; workspace: LocalWorkspaceInfo}> {
  try {
  const existing = await getLocalWorkspaceInfo(db);
  if (existing) return {user: await loginLocal(input.pin, undefined, db), workspace: existing};
  const businessName = input.businessName?.trim();
  const ownerName = input.ownerName?.trim();
  const demo = input.demo === true;
  requireLocal(typeof businessName === 'string' && businessName.length >= 2 && businessName.length <= 100, 'Enter a business name containing 2 to 100 characters.');
  requireLocal(typeof ownerName === 'string' && ownerName.length >= 2 && ownerName.length <= 100, 'Enter an owner name containing 2 to 100 characters.');
  requireLocal(typeof input.pin === 'string' && (demo ? /^\d{4,12}$/ : /^\d{6,12}$/).test(input.pin), demo ? 'Use a demo PIN containing 4 to 12 digits.' : 'Choose a private owner PIN containing 6 to 12 digits.');
  const createdAt = now();
  const workspace: LocalWorkspaceInfo = {version: 1, workspaceId: uid('workspace'), deviceId: uid('device'), businessName, demo, createdAt};
  const owner: StaffMember = {id:'staff-owner',name:ownerName,role:'owner',branchId:null,initials:ownerName.split(/\s+/).slice(0,2).map(word=>word[0]).join('').toUpperCase(),active:true,phone:'',lastActive:createdAt};
  const credential = await createLocalCredential(owner.id, input.pin);
  const authenticated = await prepareLocalSession(owner.id);
  await db.transaction('rw', db.tables, async () => {
    requireLocal(!await getLocalWorkspaceInfo(db), 'This device was just set up in another tab. Sign in to continue.', 409, 'ALREADY_INITIALIZED');
    requireLocal(await db.records.count() === 0 && await db.credentials.count() === 0, 'This device contains workspace data without a valid setup marker. Restore a verified backup before continuing.', 409, 'WORKSPACE_RECOVERY_REQUIRED');
    const store = new LocalStore(db);
    const branch: Branch = {id:'b1',name:demo?'Colombo':'Main branch',nameSi:demo?'Colombo':'Main branch',code:demo?'CMB':'MAIN',address:'',phone:''};
    await store.put('branch', branch);
    await store.put('staff', owner);
    for (const category of categories) await store.put('category', category);
    const settings: Settings = {businessName,tagline:'Restaurant & kitchen',currency:'LKR',taxRate:0,serviceChargeRate:0,receiptFooter:'Thank you for dining with us. See you again!',lowStockAlerts:true,autoPrint:false,language:'en',...localReceiptDefaults};
    await store.setMeta('settings', settings);
    await store.setMeta('deviceId', workspace.deviceId);
    await store.setMeta('activeBranchId', branch.id);
    await store.setMeta('journalSequence', 0);
    await store.setMeta('storageFormat', 1);
    for (let index = 1; index <= 12; index++) await store.put<DiningTable>('table', {id:`b1-t${index}`,branchId:'b1',name:`T${String(index).padStart(2,'0')}`,seats:index>8?6:4,area:index>8?'Terrace':'Main hall',status:'available'});
    if (demo) {
      for (const item of demoMenu()) {
        await store.put('menu', item);
        if (item.stockMode === 'prepared') await store.put<InventoryItem>('inventory', {id:`b1-prepared-${item.id}`,branchId:'b1',name:item.name,nameSi:item.name,category:'prepared',unit:'portions',quantity:50,minimum:10,unitCost:item.cost,supplierId:null,menuItemId:item.id,updatedAt:createdAt});
      }
      for (const recipe of demoRecipes) await store.put('recipe', recipe);
      for (const item of demoIngredients) await store.put<InventoryItem>('inventory', {id:`b1-${item.key}`,branchId:'b1',name:item.name,nameSi:item.name,category:'ingredient',unit:item.unit,quantity:item.quantity,minimum:5,unitCost:item.cost,supplierId:null,menuItemId:null,updatedAt:createdAt});
      await store.put('customer', {id:'c1',name:'Sample guest',phone:'',email:'',visits:0,spent:0,balance:0,points:0,createdAt});
      await store.put<Shift>('shift', {id:'b1-shift-demo',branchId:'b1',openedBy:owner.id,openedAt:createdAt,openingFloat:0,status:'open',closedAt:null,countedCash:null,expectedCash:0,variance:null});
    }
    await db.credentials.put(credential);
    await db.sessions.put(authenticated.session);
    // This marker commits with every record and credential. A failed or full
    // database must never leave a misleading "setup complete" flag behind.
    await store.setMeta('workspace', workspace);
  });
  rememberLocalSession(db, authenticated.sessionToken);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('local-workspace-change'));
  return {user: publicLocalUser(owner), workspace};
  } catch (error) {throw localStorageError(error);}
}
