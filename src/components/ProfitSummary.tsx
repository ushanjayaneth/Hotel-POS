import { useState } from 'react';
import { ArrowDownRight, ArrowUpRight, CalendarDays, Download, Leaf, TrendingUp } from 'lucide-react';
import type { Snapshot } from '../../shared/types';
import { businessDate, profitability, profitCsv } from '../../shared/costing';
import { money, number } from '../lib/format';
import '../styles/profit.css';

export default function ProfitSummary({ data, from, to }: { data: Snapshot; from?: string; to?: string }) {
  const today = businessDate(new Date().toISOString());
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(today);
  if (!['owner', 'manager', 'accountant'].includes(data.user.role)) return null;
  const selectedFrom = from ?? start;
  const selectedTo = to ?? end;
  const invalidRange = selectedFrom > selectedTo;
  const report = profitability(data, selectedFrom, selectedTo);
  const profitable = report.operatingProfit >= 0;
  function download() {
    const url = URL.createObjectURL(new Blob([profitCsv(report)], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `profit-${data.branch.code}-${selectedFrom}-${selectedTo}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="profit-summary panel" aria-label="Daily profitability">
    <div className="profit-heading">
      <div className="profit-title"><span className="profit-icon"><TrendingUp size={20} /></span><div><span className="eyebrow">KNOW YOUR MARGIN</span><h2>Daily profitability</h2><p>Ingredients become portions. Portions become profit.</p></div></div>
      <div className="profit-controls">
        {!from && <label><CalendarDays size={14} /><span className="sr-only">Profit from date</span><input aria-label="Profit from date" type="date" value={start} max={end} onChange={event => setStart(event.target.value || today)} /></label>}
        {!to && <label><span className="sr-only">Profit to date</span><input aria-label="Profit to date" type="date" value={end} min={selectedFrom} onChange={event => setEnd(event.target.value || today)} /></label>}
        <button className="button secondary" disabled={invalidRange} onClick={download}><Download size={15} /> Profit CSV</button>
      </div>
    </div>
    {invalidRange ? <p className="profit-notice">Choose an end date on or after the start date.</p> : <>
      <div className="profit-metrics">
        <div><span>Net food &amp; product sales</span><strong>{money(report.netSales)}</strong><small>{number(report.bills)} confirmed bills · after discounts / refunds</small></div>
        <div><span>Cost of sales</span><strong>{money(report.costOfSales)}</strong><small>Purchased goods, ingredients &amp; prepared portions</small></div>
        <div className={report.grossProfit >= 0 ? 'profit-positive' : 'profit-negative'}><span>Gross profit</span><strong>{money(report.grossProfit)}</strong><small>{report.margin.toFixed(1)}% gross margin · before overheads</small></div>
      </div>
      <div className="profit-result">
        <div className={`profit-result-main ${profitable ? 'profit-positive' : 'profit-negative'}`}>
          {profitable ? <ArrowUpRight size={27} /> : <ArrowDownRight size={27} />}
          <div><span>Operating profit estimate</span><strong>{money(report.operatingProfit)}</strong></div>
        </div>
        <div className="profit-deductions"><span>Gross profit <b>{money(report.grossProfit)}</b></span><span>Cancelled food cost <b>− {money(report.cancelledCost)}</b></span><span>Recorded wastage <b>? {money(report.wastageCost)}</b></span><span>Recorded operating expenses <b>− {money(report.operatingExpenses)}</b></span></div>
      </div>
      {(report.estimatedLines > 0 || report.missingCostLines > 0) && <p className="profit-notice"><Leaf size={16} /><span>{report.estimatedLines > 0 ? `${number(report.estimatedLines)} bill lines use estimated costs. Older bills without a saved cost use current product costs. ` : ''}{report.missingCostLines > 0 ? `${number(report.missingCostLines)} lines have incomplete cost setup. Complete recipes and linked stock for future sales.` : 'New bills retain the cost captured when they are confirmed.'}</span></p>}
      <div className="profit-table-heading"><h3>Profit by product</h3><span>{selectedFrom === selectedTo ? selectedFrom : `${selectedFrom} — ${selectedTo}`} · Asia/Colombo</span></div>
      <div className="profit-table-scroll"><table className="profit-table"><thead><tr><th>Product</th><th>Units</th><th>Net sales</th><th>Cost</th><th>Gross profit</th><th>Margin</th></tr></thead><tbody>
        {report.products.map(product => <tr key={product.id}><td><strong>{product.name}</strong>{product.estimated && <small>Includes estimated costs</small>}{product.wasteCost > 0 && <small>Cancelled food cost: {money(product.wasteCost)}</small>}</td><td>{number(product.quantity)}</td><td>{money(product.netSales)}</td><td>{money(product.cost)}</td><td className={product.grossProfit >= 0 ? 'profit-positive' : 'profit-negative'}>{money(product.grossProfit)}</td><td>{product.netSales > 0 ? `${(product.grossProfit / product.netSales * 100).toFixed(1)}%` : '—'}</td></tr>)}
        {report.products.length === 0 && <tr><td colSpan={6} className="profit-empty">No confirmed bills in this period. Product costs will appear after your first sale.</td></tr>}
      </tbody></table></div>
      <p className="profit-basis">Confirmed-bill basis, including unpaid bills and customer credit; collections are not counted again. Tax and service charges are excluded. Refunds adjust the original bill date and do not restore consumed food cost. Stock purchases are counted through cost of sales, not deducted twice. The operating estimate includes recorded expenses, wastage and cancelled food; unrecorded overheads and other stock write-offs are excluded.</p>
      {report.excludedInventoryExpenses > 0 && <p className="profit-basis">Inventory purchase expense entries excluded: {money(report.excludedInventoryExpenses)}.</p>}
    </>}
  </section>;
}
