import test from 'node:test';
import assert from 'node:assert/strict';
import type {InventoryItem,MenuItem,Recipe} from '../shared/types';
import {productStockState} from '../shared/stock';

const item:MenuItem={id:'product',name:'Rice',nameSi:'Rice',description:'',categoryId:'rice',price:35000,cost:20000,image:'/images/curry.jpg',available:true,stockMode:'prepared',preparationMinutes:0};
const stock=(values:Partial<InventoryItem>={}):InventoryItem=>({id:'b1-rice',branchId:'b1',name:'Rice',nameSi:'Rice',category:'prepared',unit:'pcs',quantity:5,minimum:5,unitCost:20000,supplierId:null,menuItemId:'product',updatedAt:new Date().toISOString(),...values});
test('product alerts default to five, allow a per-product override and preserve explicit zero',()=>{
  assert.equal(productStockState(item,[],[],'b1').threshold,5);
  assert.equal(productStockState(item,[stock()],[],'b1').low,true);
  assert.equal(productStockState(item,[stock({quantity:6})],[],'b1').low,false);
  assert.equal(productStockState({...item,reorderLevel:10},[stock({quantity:6,minimum:0})],[],'b1').low,true);
  assert.equal(productStockState({...item,reorderLevel:0},[stock({quantity:1})],[],'b1').low,false);
  assert.equal(productStockState({...item,reorderLevel:0},[stock({quantity:0})],[],'b1').low,true);
});
test('recipe alerts use limiting ingredient portions in this branch and tolerate decimal stock units',()=>{
  const recipes:Recipe[]=[{id:'product',ingredients:[{key:'rice',quantity:.4},{key:'egg',quantity:1}]}];
  const inventory=[stock({category:'ingredient',menuItemId:null,quantity:1.2}),stock({id:'b1-egg',category:'ingredient',menuItemId:null,quantity:20}),stock({id:'b2-rice',branchId:'b2',quantity:100})];
  const state=productStockState({...item,stockMode:'recipe'},inventory,recipes,'b1');
  assert.equal(state.quantity,3);assert.equal(state.low,true);assert.equal(state.unit,'portions');
  assert.equal(productStockState({...item,stockMode:'untracked'},inventory,recipes,'b1').low,false);
  assert.equal(productStockState({...item,stockMode:'untracked'},inventory,recipes,'b1').quantity,null);
});
