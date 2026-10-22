import type {InventoryItem, MenuItem, Recipe} from './types.js';

export interface ProductStockState {quantity:number|null;threshold:number;low:boolean;unit:string}

/** Branch quantities only; recipe availability is the number of complete portions. */
export function productStockState(item:MenuItem,inventory:InventoryItem[],recipes:Recipe[],branchId:string):ProductStockState {
  const stock=inventory.find(row=>row.branchId===branchId&&row.menuItemId===item.id&&['prepared','resale'].includes(row.category));
  const threshold=item.reorderLevel??stock?.minimum??5;
  if(item.stockMode==='untracked')return{quantity:null,threshold,low:false,unit:'units'};
  let quantity=stock?.quantity??0,unit=stock?.unit??'portions';
  if(item.stockMode==='recipe'){
    const recipe=recipes.find(row=>row.id===item.id);
    quantity=recipe?.ingredients.length?Math.min(...recipe.ingredients.map(line=>{
      const ingredient=inventory.find(row=>row.branchId===branchId&&(row.id===`${branchId}-${line.key}`||row.id===line.key));
      return line.quantity>0?Math.max(0,Math.floor(((ingredient?.quantity??0)+1e-9)/line.quantity)):0;
    })):0;
    unit='portions';
  }
  return{quantity,threshold,low:quantity<=threshold,unit};
}
