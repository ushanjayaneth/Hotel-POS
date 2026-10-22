import type {CloudChange} from './cloud-monitor';
import type {Snapshot,Branch,Settings,MenuItem,InventoryItem,Recipe,Customer,CreditEntry} from './types';
import {productStockState} from './stock';

export function monitoringSnapshot(records:CloudChange[],branchId?:string):Snapshot{
  const list=<T>(kind:string,scoped=false)=>records.filter(row=>row.kind===kind&&(!scoped||row.branchId===branch.id)).map(row=>row.value as T);
  const branches=records.filter(row=>row.kind==='branch').map(row=>row.value as unknown as Branch);
  const branch=branches.find(row=>row.id===branchId)??branches[0];
  if(!branch)throw new Error('The initial branch upload has not finished.');
  const settings=records.find(row=>row.kind==='settings')?.value as unknown as Settings;
  if(!settings)throw new Error('The initial settings upload has not finished.');
  const inventory=list<InventoryItem>('inventory',true),recipes=list<Recipe>('recipe'),credits=list<CreditEntry>('credit',true);
  const menu=list<MenuItem>('menu').map(item=>{const stock=productStockState(item,inventory,recipes,branch.id);return {...item,stockQuantity:stock.quantity,lowStock:stock.low};});
  const customers=list<Customer>('customer').map(customer=>({...customer,balance:credits.filter(entry=>entry.customerId===customer.id).reduce((sum,entry)=>sum+(entry.type==='sale'?entry.amount:-entry.amount),0)}));
  return {user:{id:'cloud-owner',name:'Cloud owner',initials:'CO',role:'owner',branchId:null},branches,branch,settings,categories:list('category'),menu,recipes,inventory,
    orders:list('order',true),customers,creditEntries:credits,heldBills:list('held',true),tables:list('table',true),stockMovements:list('movement',true),production:list('production',true),purchases:list('purchase',true),suppliers:list('supplier'),expenses:list('expense',true),shifts:list('shift',true),staff:list('staff'),audit:list('audit',true),sync:{configured:true,pending:0,synced:0,failed:0,lastSync:null,lastError:null,lastBackup:null,hubOnline:true},serverTime:new Date().toISOString()};
}
