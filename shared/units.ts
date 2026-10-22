const units:Record<string,{dimension:string;factor:number}>={kg:{dimension:'mass',factor:1000},g:{dimension:'mass',factor:1},mg:{dimension:'mass',factor:.001},l:{dimension:'volume',factor:1000},ml:{dimension:'volume',factor:1}};
export function compatibleUnits(stockUnit:string):string[]{const unit=units[stockUnit.toLowerCase()];return unit?Object.keys(units).filter(key=>units[key].dimension===unit.dimension).map(key=>key==='l'?'L':key):[stockUnit];}
export function convertQuantity(quantity:number,from:string,to:string):number{
  if(!Number.isFinite(quantity)||quantity<0)throw new Error('Enter a non-negative measured quantity.');
  if(from.toLowerCase()===to.toLowerCase())return quantity;
  const source=units[from.toLowerCase()],target=units[to.toLowerCase()];
  if(!source||!target||source.dimension!==target.dimension)throw new Error('Only compatible weight or volume units can be converted.');
  return Math.round(quantity*source.factor/target.factor*1e8)/1e8;
}
