import assert from 'node:assert/strict';
import {test} from 'node:test';
import {profitability,profitCsv} from '../shared/costing';
import type {CreditEntry,Customer,Order} from '../shared/types';

const customer:Customer={id:'guest',name:'Loan Guest',phone:'0771234567',email:'',visits:1,spent:65000,balance:0,points:0,createdAt:'2026-01-01T08:00:00Z'};
const sale:Order={id:'bill',number:'CMB-001',branchId:'b1',type:'takeaway',tableId:null,customerId:'guest',status:'completed',paymentStatus:'paid',subtotal:65000,discount:0,tax:0,serviceCharge:0,total:65000,paid:65000,refunded:0,note:'',createdAt:'2026-01-02T08:00:00Z',updatedAt:'2026-01-02T08:00:00Z',createdBy:'owner',version:1,lines:[{id:'line',menuItemId:'meal',name:'Rice',nameSi:'Rice',quantity:1,unitPrice:65000,unitCost:25000,costBasis:'captured',lineTotal:65000,note:''}],payments:[{id:'payment',orderId:'bill',method:'credit',amount:65000,received:65000,change:0,reference:'',createdAt:'2026-01-02T08:00:00Z'}]};
const entry=(id:string,type:CreditEntry['type'],amount:number,changes:Partial<CreditEntry>={}):CreditEntry=>({id,branchId:'b1',customerId:'guest',type,amount,method:type==='collection'?'cash':'credit',orderId:type==='collection'?null:'bill',reference:'',note:'',createdAt:'2026-01-02T08:00:00Z',createdBy:'owner',...changes});
const fixture=(creditEntries?:CreditEntry[],orders:Order[]=[sale],customers:Customer[]=[customer])=>({branch:{id:'b1',name:'Colombo',nameSi:'Colombo',code:'CMB',address:'',phone:''},menu:[],recipes:[],inventory:[],orders,expenses:[],customers,creditEntries});

test('missing loan ledger is unavailable while an included empty ledger reports a real zero',()=>{
  const unavailable=profitability(fixture(),'2026-01-02');
  assert.equal(unavailable.loanSummary,null);
  assert.match(profitCsv(unavailable),/Unavailable: customer ledger was not included/);
  assert.deepEqual(profitability(fixture([]),'2026-01-02').loanSummary,{asOf:'2026-01-02',creditSales:0,collections:0,creditRefunds:0,outstanding:0,advances:0,customers:[]});
});

test('partial and full loan repayments reduce red receivables without booking another sale or profit',()=>{
  const issued=entry('loan','sale',65000);
  const partial=entry('part','collection',20000);
  const remaining=entry('rest','collection',45000);
  const reports=[[issued],[issued,partial],[issued,partial,remaining]].map(entries=>profitability(fixture(entries),'2026-01-02'));
  assert.deepEqual(reports.map(report=>report.loanSummary!.outstanding),[65000,45000,0]);
  assert.deepEqual(reports.map(report=>report.loanSummary!.collections),[0,20000,65000]);
  assert.deepEqual(reports.map(report=>report.netSales),[65000,65000,65000]);
  assert.deepEqual(reports.map(report=>report.grossProfit),[40000,40000,40000]);
  // The loan settled the checkout bill, so order.paid cannot identify debt.
  assert.equal(reports[0].outstanding,0);
  assert.deepEqual(reports[1].loanSummary!.customers,[{customerId:'guest',name:'Loan Guest',phone:'0771234567',balance:45000}]);
  assert.deepEqual(reports[2].loanSummary!.customers,[]);
});

test('historical balances include earlier loans and exclude later collections, regardless of current customer balance',()=>{
  const entries=[entry('loan','sale',65000,{createdAt:'2026-01-01T08:00:00Z'}),entry('part','collection',20000),entry('rest','collection',45000,{createdAt:'2026-01-03T08:00:00Z'})];
  const data=fixture(entries,[{...sale,createdAt:'2026-01-01T08:00:00Z'}]);
  const today=profitability(data,'2026-01-02');
  assert.equal(today.netSales,0);assert.equal(today.grossProfit,0);
  assert.equal(today.loanSummary!.creditSales,0);assert.equal(today.loanSummary!.collections,20000);assert.equal(today.loanSummary!.outstanding,45000);
  assert.equal(profitability(data,'2026-01-01').loanSummary!.outstanding,65000);
  assert.equal(profitability(data,'2026-01-03').loanSummary!.outstanding,0);
  assert.equal(profitability(data,'2026-01-01','2026-01-03').loanSummary!.collections,65000);
});

test('credit refunds reduce debt without pretending money was received and customer advances never offset another debt',()=>{
  const entries=[entry('loan','sale',65000),entry('part','collection',20000),entry('refund','refund',10000),entry('other-loan','sale',5000,{customerId:'advance'}),entry('other-paid','collection',10000,{customerId:'advance'})];
  const report=profitability(fixture(entries,[{...sale,refunded:10000}],[customer,{...customer,id:'advance',name:'Advance Guest',balance:-5000}]),'2026-01-02');
  assert.equal(report.loanSummary!.creditSales,70000);assert.equal(report.loanSummary!.collections,30000);assert.equal(report.loanSummary!.creditRefunds,10000);
  assert.equal(report.loanSummary!.outstanding,35000);assert.equal(report.loanSummary!.advances,5000);
  assert.deepEqual(report.loanSummary!.customers.map(row=>row.balance),[35000,-5000]);
  assert.equal(report.netSales,55000);assert.equal(report.grossProfit,30000);
});

test('loan period totals and end balances follow Colombo dates, branch scope and ledger identities',()=>{
  const entries=[entry('prior','sale',7000,{createdAt:'2026-01-01T18:29:59Z'}),entry('today','sale',3000,{createdAt:'2026-01-01T18:30:00Z'}),entry('collection','collection',2000),entry('future','sale',10000,{createdAt:'2026-01-02T18:30:00Z'}),entry('foreign','sale',50000,{branchId:'b2'})];
  const report=profitability(fixture(entries,[],[]),'2026-01-02');
  assert.equal(report.loanSummary!.creditSales,3000);assert.equal(report.loanSummary!.collections,2000);assert.equal(report.loanSummary!.outstanding,8000);
  assert.deepEqual(report.loanSummary!.customers,[{customerId:'guest',name:'guest',phone:'',balance:8000}]);
});

test('profit export contains the same loan amounts, customer details, separate advances and collection basis',()=>{
  const report=profitability(fixture([entry('loan','sale',65000),entry('part','collection',20000)],[sale],[{...customer,name:'=SUM(1,2)',phone:'+94771234567'}]),'2026-01-02');
  const csv=profitCsv(report);
  assert.match(csv,/"Customer loans outstanding \(LKR\)","450\.00"/);
  assert.match(csv,/"Loan repayments received in period \(LKR\)","200\.00"/);
  assert.match(csv,/"'=SUM\(1,2\)","'\+94771234567","450\.00","0\.00"/);
  assert.match(csv,/not another sale or additional profit/);
  assert.match(csv,/Outstanding includes older loans through the end date/);
  assert.match(csv,/Includes unpaid and credit bills/);
});
