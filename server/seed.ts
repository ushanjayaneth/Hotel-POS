import type { Branch, Category, MenuItem, StaffMember, InventoryItem, DiningTable, Order, Settings, Supplier, Customer, Shift, ProductionBatch, Purchase, StockMovement, Recipe } from '../shared/types';
import { Store, now } from './database';
import { setPin } from './security';

export function initialize(store: Store, demo: boolean) {
  if (store.meta('initialized')) return;
  if (!demo && !/^\d{6,12}$/.test(process.env.INITIAL_ADMIN_PIN ?? '')) throw new Error('Set INITIAL_ADMIN_PIN to a unique 6–12 digit PIN before starting with POS_DEMO_MODE=false.');
  store.transaction(() => {
    const branches: Branch[] = [
      { id: 'b1', name: 'Colombo', nameSi: 'කොළඹ', code: 'CMB', address: '24, Galle Road, Colombo 03', phone: '+94 11 234 5678' },
      { id: 'b2', name: 'Kandy', nameSi: 'මහනුවර', code: 'KDY', address: '18, Dalada Veediya, Kandy', phone: '+94 81 234 5678' },
      { id: 'b3', name: 'Galle', nameSi: 'ගාල්ල', code: 'GLE', address: '8, Church Street, Galle', phone: '+94 91 234 5678' },
    ];
    branches.slice(0, demo ? 3 : 1).forEach(x => store.put('branch', x));
    const settings: Settings = { businessName: 'DEMO HOTEL', tagline: 'Restaurant & kitchen', currency: 'LKR', taxRate: 0, serviceChargeRate: 0, receiptFooter: 'Thank you for dining with us. See you again!', lowStockAlerts: true, autoPrint: false, language: 'en' };
    store.setMeta('settings', JSON.stringify(settings));
    const categories: Category[] = [
      { id: 'rice', name: 'Rice & curry', nameSi: 'බත් සහ ව්‍යංජන', icon: 'rice' },
      { id: 'kottu', name: 'Kottu', nameSi: 'කොත්තු', icon: 'flame' },
      { id: 'noodles', name: 'Noodles', nameSi: 'නූඩ්ල්ස්', icon: 'noodles' },
      { id: 'short-eats', name: 'Short eats', nameSi: 'කෙටි කෑම', icon: 'croissant' },
      { id: 'beverages', name: 'Beverages', nameSi: 'පාන වර්ග', icon: 'cup' },
      { id: 'desserts', name: 'Desserts', nameSi: 'අතුරුපස', icon: 'cake' },
    ];
    categories.forEach(x => store.put('category', x));
    const menu: MenuItem[] = [
      {id:'m1',name:'Chicken rice & curry',nameSi:'කුකුළු මස් බත්',description:'Steamed samba rice, chicken curry and three seasonal vegetables.',categoryId:'rice',price:65000,cost:27500,image:'/images/chicken-rice.jpg',available:true,stockMode:'prepared',badge:'Bestseller',preparationMinutes:5},
      {id:'m2',name:'Vegetable rice & curry',nameSi:'එළවළු බත්',description:'Samba rice, dhal, fresh mallung and seasonal vegetable curries.',categoryId:'rice',price:42000,cost:16000,image:'/images/veg-rice.jpg',available:true,stockMode:'prepared',badge:'Vegetarian',preparationMinutes:4},
      {id:'m3',name:'Chicken cheese kottu',nameSi:'චීස් චිකන් කොත්තු',description:'Chopped godamba roti, chicken, egg and melted cheese.',categoryId:'kottu',price:95000,cost:42000,image:'/images/kottu.jpg',available:true,stockMode:'recipe',badge:'Popular',preparationMinutes:12},
      {id:'m4',name:'Vegetable noodles',nameSi:'එළවළු නූඩ්ල්ස්',description:'Wok-tossed noodles with crisp vegetables and a light soy glaze.',categoryId:'noodles',price:58000,cost:24000,image:'/images/noodles.jpg',available:true,stockMode:'recipe',preparationMinutes:10},
      {id:'m5',name:'Chicken biryani',nameSi:'චිකන් බිරියානි',description:'Fragrant basmati rice, spiced chicken and cooling raita.',categoryId:'rice',price:85000,cost:38000,image:'/images/biryani.jpg',available:true,stockMode:'prepared',preparationMinutes:6},
      {id:'m6',name:'Egg hopper',nameSi:'බිත්තර ආප්ප',description:'Crisp coconut-milk hopper with a soft egg and lunu miris.',categoryId:'short-eats',price:18000,cost:6500,image:'/images/hoppers.jpg',available:true,stockMode:'recipe',preparationMinutes:6},
      {id:'m7',name:'Vegetable samosa',nameSi:'එළවළු සමෝසා',description:'Golden pastry filled with gently spiced potato and vegetables.',categoryId:'short-eats',price:12000,cost:4500,image:'/images/samosa.jpg',available:true,stockMode:'prepared',preparationMinutes:2},
      {id:'m8',name:'Fresh lime juice',nameSi:'දෙහි යුෂ',description:'Freshly squeezed lime, a little sugar and plenty of ice.',categoryId:'beverages',price:28000,cost:8500,image:'/images/lime.jpg',available:true,stockMode:'recipe',preparationMinutes:3},
      {id:'m9',name:'Ceylon milk tea',nameSi:'කිරි තේ',description:'Strong Ceylon tea, fresh milk and your choice of sweetness.',categoryId:'beverages',price:15000,cost:5000,image:'/images/tea.jpg',available:true,stockMode:'recipe',preparationMinutes:3},
      {id:'m10',name:'Cappuccino',nameSi:'කැපුචිනෝ',description:'Rich espresso topped with silky steamed milk and a soft foam.',categoryId:'beverages',price:35000,cost:12500,image:'/images/coffee.jpg',available:true,stockMode:'recipe',preparationMinutes:4},
      {id:'m11',name:'Watalappan',nameSi:'වටලප්පන්',description:'Coconut custard, kithul jaggery, cardamom and cashew.',categoryId:'desserts',price:28000,cost:10000,image:'/images/watalappan.jpg',available:true,stockMode:'prepared',preparationMinutes:1},
      {id:'m12',name:'Traditional rice & curry',nameSi:'සාම්ප්‍රදායික බත් සහ ව්‍යංජන',description:'A generous Sri Lankan rice plate with dhal and seasonal vegetable curries.',categoryId:'rice',price:78000,cost:34000,image:'/images/curry.jpg',available:true,stockMode:'prepared',preparationMinutes:5},
    ];
    menu.forEach(x => store.put('menu', x));
    const owner: StaffMember = {id:'staff-owner',name:demo?'Nimal Perera':'Administrator',role:'owner',branchId:null,initials:demo?'NP':'AD',active:true,phone:'+94 77 123 4567',lastActive:null};
    store.put('staff',owner); setPin(store,owner.id,demo?'1234':process.env.INITIAL_ADMIN_PIN!);
    if(demo) [
      {id:'staff-cashier',name:'Dilini Fernando',role:'cashier',pin:'2222',initials:'DF'},
      {id:'staff-waiter',name:'Kasun Silva',role:'waiter',pin:'3333',initials:'KS'},
      {id:'staff-kitchen',name:'Amal Jayasinghe',role:'kitchen',pin:'4444',initials:'AJ'},
      {id:'staff-storekeeper',name:'Ruwan Dias',role:'storekeeper',pin:'5555',initials:'RD'},
      {id:'staff-manager',name:'Tharushi Senanayake',role:'manager',pin:'6666',initials:'TS'},
      {id:'staff-accountant',name:'Sachini De Silva',role:'accountant',pin:'7777',initials:'SD'},
    ].forEach(x=> {store.put('staff',{id:x.id,name:x.name,role:x.role,branchId:'b1',initials:x.initials,active:true,phone:'',lastActive:null});setPin(store,x.id,x.pin);});
    const suppliers: Supplier[] = [
      {id:'s1',name:'Green Valley Produce',phone:'+94 77 456 7890',email:'orders@greenvalley.example',balance:0},
      {id:'s2',name:'Ceylon Fresh Foods',phone:'+94 71 234 5678',email:'supply@ceylonfresh.example',balance:0},
      {id:'s3',name:'Island Dairy & Pantry',phone:'+94 76 456 7890',email:'hello@islanddairy.example',balance:0},
    ];
    suppliers.forEach(x=>store.put('supplier',x));
    const ingredients = [
      {key:'rice',name:'Samba rice',unit:'kg',quantity:86,minimum:25,cost:24500,supplierId:'s1'},
      {key:'chicken',name:'Fresh chicken',unit:'kg',quantity:34,minimum:15,cost:130000,supplierId:'s2'},
      {key:'vegetables',name:'Mixed vegetables',unit:'kg',quantity:18,minimum:20,cost:38000,supplierId:'s1'},
      {key:'egg',name:'Farm eggs',unit:'pcs',quantity:180,minimum:60,cost:4500,supplierId:'s2'},
      {key:'roti',name:'Godamba roti',unit:'pcs',quantity:80,minimum:30,cost:6500,supplierId:'s2'},
      {key:'cheese',name:'Cheddar cheese',unit:'kg',quantity:3.4,minimum:4,cost:280000,supplierId:'s3'},
      {key:'noodles',name:'Egg noodles',unit:'kg',quantity:22,minimum:8,cost:68000,supplierId:'s3'},
      {key:'hopper',name:'Hopper batter',unit:'litre',quantity:15,minimum:4,cost:42000,supplierId:'s1'},
      {key:'lime',name:'Fresh lime',unit:'kg',quantity:8.2,minimum:5,cost:65000,supplierId:'s1'},
      {key:'sugar',name:'White sugar',unit:'kg',quantity:12,minimum:5,cost:30000,supplierId:'s3'},
      {key:'milk',name:'Fresh milk',unit:'litre',quantity:24,minimum:10,cost:52000,supplierId:'s3'},
      {key:'tea',name:'Ceylon tea',unit:'kg',quantity:4.5,minimum:2,cost:185000,supplierId:'s3'},
      {key:'coffee',name:'Ground coffee',unit:'kg',quantity:3,minimum:2,cost:320000,supplierId:'s3'},
      {key:'pork',name:'Fresh pork',unit:'kg',quantity:14,minimum:5,cost:180000,supplierId:'s2'},
      {key:'flour',name:'Wheat flour',unit:'kg',quantity:36,minimum:10,cost:19500,supplierId:'s1'},
      {key:'coconut',name:'Coconut milk',unit:'litre',quantity:16,minimum:6,cost:65000,supplierId:'s1'},
      {key:'jaggery',name:'Kithul jaggery',unit:'kg',quantity:6,minimum:2,cost:125000,supplierId:'s3'},
    ];
    const recipes: Recipe[] = [
      {id:'m1',ingredients:[{key:'rice',quantity:.2},{key:'chicken',quantity:.15},{key:'vegetables',quantity:.15}]},
      {id:'m2',ingredients:[{key:'rice',quantity:.2},{key:'vegetables',quantity:.25}]},
      {id:'m3',ingredients:[{key:'roti',quantity:2},{key:'chicken',quantity:.12},{key:'egg',quantity:1},{key:'vegetables',quantity:.1},{key:'cheese',quantity:.05}]},
      {id:'m4',ingredients:[{key:'noodles',quantity:.2},{key:'vegetables',quantity:.12}]},
      {id:'m5',ingredients:[{key:'rice',quantity:.25},{key:'chicken',quantity:.2},{key:'vegetables',quantity:.1}]},
      {id:'m6',ingredients:[{key:'hopper',quantity:.12},{key:'egg',quantity:1}]},
      {id:'m7',ingredients:[{key:'flour',quantity:.06},{key:'vegetables',quantity:.05}]},
      {id:'m8',ingredients:[{key:'lime',quantity:.1},{key:'sugar',quantity:.025}]},
      {id:'m9',ingredients:[{key:'tea',quantity:.006},{key:'milk',quantity:.1},{key:'sugar',quantity:.015}]},
      {id:'m10',ingredients:[{key:'coffee',quantity:.015},{key:'milk',quantity:.18},{key:'sugar',quantity:.02}]},
      {id:'m11',ingredients:[{key:'egg',quantity:.5},{key:'coconut',quantity:.08},{key:'jaggery',quantity:.04}]},
      {id:'m12',ingredients:[{key:'rice',quantity:.2},{key:'vegetables',quantity:.25},{key:'coconut',quantity:.05}]},
    ];
    recipes.forEach(x=>store.put('recipe',x));
    for(const branch of branches.slice(0,demo?3:1)) {
      ingredients.forEach(x=>store.put<InventoryItem>('inventory',{id:`${branch.id}-${x.key}`,branchId:branch.id,name:x.name,nameSi:x.name,category:'ingredient',unit:x.unit,quantity:demo?x.quantity:0,minimum:x.minimum,unitCost:x.cost,supplierId:x.supplierId,menuItemId:null,updatedAt:now()}));
      menu.filter(x=>x.stockMode==='prepared').forEach((x,i)=>store.put<InventoryItem>('inventory',{id:`${branch.id}-prepared-${x.id}`,branchId:branch.id,name:x.name,nameSi:x.nameSi,category:'prepared',unit:'portions',quantity:demo?[42,28,18,36,16,14][i]:0,minimum:10,unitCost:x.cost,supplierId:null,menuItemId:x.id,updatedAt:now()}));
      store.put<InventoryItem>('inventory',{id:`${branch.id}-boxes`,branchId:branch.id,name:'Takeaway containers',nameSi:'Takeaway containers',category:'packaging',unit:'pcs',quantity:demo?240:0,minimum:100,unitCost:3500,supplierId:'s3',menuItemId:null,updatedAt:now()});
      for(let i=1;i<=12;i++) store.put<DiningTable>('table',{id:`${branch.id}-t${i}`,branchId:branch.id,name:`T${String(i).padStart(2,'0')}`,seats:i>8?6:4,area:i>8?'Terrace':'Main hall',status:'available'});
      if(demo) store.put<Shift>('shift',{id:`${branch.id}-shift-demo`,branchId:branch.id,openedBy:'staff-owner',openedAt:new Date(Date.now()-5*3600000).toISOString(),openingFloat:1500000,status:'open',closedAt:null,countedCash:null,expectedCash:1500000,variance:null});
    }
    if(demo) {
      const customers: Customer[] = [
        {id:'c1',name:'Shanika Perera',phone:'+94 77 221 4567',email:'shanika@example.com',visits:0,spent:0,balance:0,points:0,createdAt:now()},
        {id:'c2',name:'Dinesh Wijesinghe',phone:'+94 71 567 8901',email:'dinesh@example.com',visits:0,spent:0,balance:0,points:0,createdAt:now()},
        {id:'c3',name:'Office Lunch Club',phone:'+94 11 267 8901',email:'lunch@example.com',visits:0,spent:0,balance:0,points:0,createdAt:now()},
      ];
      customers.forEach(x=>store.put('customer',x));
      let serial=1;
      for(const branch of branches) {
        for(let i=0;i<12;i++) {
          const status: Order['status'] = i<4?(['new','preparing','ready','served'] as const)[i]:'completed';
          const items=[menu[i%menu.length],menu[(i+8)%menu.length]];
          const createdAt=new Date(Date.now()-(i<4?(28-i*6)*60000:(i-2)*1800000)).toISOString();
          const id=`demo-order-${serial}`;
          const lines=items.map((x,j)=>({id:`${id}-line-${j}`,menuItemId:x.id,name:x.name,nameSi:x.nameSi,quantity:j?1:2,unitPrice:x.price,lineTotal:x.price*(j?1:2),note:j?'':'Less spicy'}));
          const total=lines.reduce((sum,x)=>sum+x.lineTotal,0);
          const paid=status==='completed'?total:0;
          const order: Order = {id,number:`${branch.code}-${String(serial).padStart(4,'0')}`,branchId:branch.id,type:i%3===0?'takeaway':'dine-in',tableId:i<4&&i%3!==0?`${branch.id}-t${i+1}`:null,customerId:i%4===0?'c1':null,status,paymentStatus:paid?'paid':'unpaid',subtotal:total,discount:0,tax:0,serviceCharge:0,total,paid,refunded:0,note:'Sample order · demo data',createdAt,updatedAt:createdAt,createdBy:'staff-cashier',version:1,lines,payments:paid?[{id:`${id}-payment`,orderId:id,method:i%2?'cash':'card',amount:paid,received:paid,change:0,reference:i%2?'':`DEMO-${serial}`,createdAt}]:[]};
          store.put('order',order);
          // Seeded orders are historical examples. Deduct their stock once here too.
          for(const line of lines) {
            const item=menu.find(x=>x.id===line.menuItemId)!;
            const changes=item.stockMode==='prepared'?[{id:`${branch.id}-prepared-${item.id}`,quantity:line.quantity}]:recipes.find(x=>x.id===item.id)!.ingredients.map(x=>({id:`${branch.id}-${x.key}`,quantity:x.quantity*line.quantity}));
            for(const change of changes) {
              const stock=store.get<InventoryItem>('inventory',change.id)!;
              stock.quantity=Math.max(0,Math.round((stock.quantity-change.quantity)*10000)/10000);store.put('inventory',stock);
            }
          }
          if(order.tableId) {const table=store.get<DiningTable>('table',order.tableId)!;store.put('table',{...table,status:'occupied',orderId:id});}
          if(paid && i%2) {const shift=store.get<Shift>('shift',`${branch.id}-shift-demo`)!;shift.expectedCash+=paid;store.put('shift',shift);}
          if(paid&&order.customerId) {const c=store.get<Customer>('customer',order.customerId)!;c.visits++;c.spent+=paid;c.points+=Math.floor(paid/10000);store.put('customer',c);}
          serial++;
        }
        store.put<ProductionBatch>('production',{id:`${branch.id}-production-demo`,branchId:branch.id,menuItemId:'m1',name:'Chicken rice & curry',quantity:40,cost:1100000,note:'Sample morning preparation',createdAt:new Date(Date.now()-5*3600000).toISOString(),createdBy:'staff-kitchen'});
        store.put<Purchase>('purchase',{id:`${branch.id}-purchase-demo`,branchId:branch.id,supplierId:'s1',supplierName:'Green Valley Produce',invoiceNumber:`DEMO-${branch.code}-001`,total:2450000,status:'received',createdAt:new Date(Date.now()-86400000).toISOString(),lines:[{itemId:`${branch.id}-rice`,name:'Samba rice',quantity:100,unitCost:24500,total:2450000}]});
        store.put<StockMovement>('movement',{id:`${branch.id}-movement-demo`,branchId:branch.id,itemId:`${branch.id}-rice`,type:'purchase',quantity:100,reason:'Sample opening purchase',createdAt:new Date(Date.now()-86400000).toISOString(),createdBy:'staff-storekeeper'});
        store.put('audit',{id:`${branch.id}-audit-demo`,branchId:branch.id,action:'demo.initialized',actor:'System',detail:'Sample operational data. Do not use the demo database for live trading.',createdAt:now()});
      }
      const supplier=store.get<Supplier>('supplier','s1')!;supplier.balance=7350000;store.put('supplier',supplier);
    }
    store.setMeta('demo',String(demo));
    store.setMeta('initialized',now());
  });
}
