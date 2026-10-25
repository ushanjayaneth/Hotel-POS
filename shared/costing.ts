import type { CreditEntry, Customer, Expense, InventoryItem, MenuItem, OrderLine, Recipe, Snapshot, StockMovement } from './types.js';

export interface ProductCost {
  unitCost: number;
  source: 'recipe' | 'stock' | 'manual';
  complete: boolean;
  ingredients: { name: string; quantity: number; unit: string; unitCost: number; cost: number }[];
}

/** Convert a kitchen batch to canonical per-portion quantities exactly once, in the editor. */
export function portionIngredients(lines: Recipe['ingredients'], batchYield: number): Recipe['ingredients'] {
  if (!Number.isFinite(batchYield) || batchYield < 1 || batchYield > 100000) throw new Error('Enter a recipe yield between 1 and 100,000 portions.');
  return lines.map(line => {
    const quantity = line.quantity / batchYield;
    if (!line.key || !Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) throw new Error('Select an ingredient and a positive quantity for every line.');
    return { key: line.key, quantity };
  });
}

/** Recipe quantities use the ingredient stock unit: e.g. 0.15 kg, not 150 g. */
export function productCost(item: MenuItem, inventory: InventoryItem[], recipes: Recipe[], branchId: string): ProductCost {
  const branchStock = inventory.filter(stock => stock.branchId === branchId);
  if (item.stockMode === 'prepared') {
    const stock = branchStock.find(stock => stock.menuItemId === item.id && ['prepared', 'resale'].includes(stock.category));
    if (stock) return { unitCost: Math.round(stock.unitCost), source: 'stock', complete: true, ingredients: [] };
  }
  if (item.stockMode === 'recipe') return recipeCost(item.id, inventory, recipes, branchId, item.cost);
  return { unitCost: Math.round(item.cost), source: 'manual', complete: item.stockMode === 'untracked', ingredients: [] };
}

export function recipeCost(menuItemId: string, inventory: InventoryItem[], recipes: Recipe[], branchId: string, fallback = 0): ProductCost {
  const recipe = recipes.find(recipe => recipe.id === menuItemId);
  if (!recipe?.ingredients.length) return { unitCost: Math.round(fallback), source: 'manual', complete: false, ingredients: [] };
  let complete = true;
  const ingredients = recipe.ingredients.map(line => {
    const stock = inventory.find(stock => stock.branchId === branchId && stock.id === `${branchId}-${line.key}`)
      ?? inventory.find(stock => stock.branchId === branchId && stock.id === line.key);
    if (!stock) complete = false;
    return { name: stock?.name ?? line.key, quantity: line.quantity, unit: stock?.unit ?? '', unitCost: stock?.unitCost ?? 0, cost: (stock?.unitCost ?? 0) * line.quantity };
  });
  return { unitCost: Math.round(ingredients.reduce((sum, line) => sum + line.cost, 0)), source: 'recipe', complete, ingredients };
}

/** Weighted moving average: never overwrite the cost of portions already in stock. */
export function weightedUnitCost(currentQuantity: number, currentUnitCost: number, addedQuantity: number, addedTotalCost: number): number {
  const totalQuantity = currentQuantity + addedQuantity;
  return totalQuantity > 0 ? Math.round((currentQuantity * currentUnitCost + addedTotalCost) / totalQuantity) : 0;
}

export const businessDate = (timestamp: string): string => new Date(timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' });

function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((value, weight) => value + weight, 0);
  if (!sum) return weights.map(() => 0);
  const result = weights.map(weight => Math.floor(total * weight / sum));
  const remainderOrder = weights.map((weight, index) => ({ index, remainder: total * weight / sum - result[index] })).sort((a, b) => b.remainder - a.remainder);
  for (let index = 0, left = total - result.reduce((value, amount) => value + amount, 0); index < left; index++) result[remainderOrder[index % remainderOrder.length].index]++;
  return result;
}

export interface ProductProfit {
  id: string;
  name: string;
  quantity: number;
  netSales: number;
  cost: number;
  grossProfit: number;
  wasteCost: number;
  estimated: boolean;
}
export interface ProfitReport {
  wastageCost: number;
  from: string;
  to: string;
  netSales: number;
  costOfSales: number;
  grossProfit: number;
  margin: number;
  cancelledCost: number;
  operatingExpenses: number;
  excludedInventoryExpenses: number;
  operatingProfit: number;
  refundedNetSales: number;
  outstanding: number;
  loanSummary: LoanSummary | null;
  estimatedLines: number;
  missingCostLines: number;
  bills: number;
  products: ProductProfit[];
  daily: { date: string; netSales: number; costOfSales: number; cancelledCost: number; wastageCost: number; operatingExpenses: number; operatingProfit: number }[];
}

export interface LoanSummary {
  asOf: string;
  creditSales: number;
  collections: number;
  creditRefunds: number;
  outstanding: number;
  advances: number;
  customers: {customerId: string; name: string; phone: string; balance: number}[];
}

/** Account repayments are not assigned to a particular bill. Keep the actual
 * customer ledger separate from bill profit instead of inventing allocations. */
function summarizeLoans(entries: CreditEntry[] | undefined, customers: Customer[] | undefined, branchId: string, from: string, to: string): LoanSummary | null {
  if (!Array.isArray(entries)) return null;
  const summary: LoanSummary = {asOf: to, creditSales: 0, collections: 0, creditRefunds: 0, outstanding: 0, advances: 0, customers: []};
  const balances = new Map<string, number>();
  for (const entry of entries) {
    if (entry.branchId !== branchId) continue;
    const date = businessDate(entry.createdAt);
    if (date > to) continue;
    balances.set(entry.customerId, (balances.get(entry.customerId) ?? 0) + (entry.type === 'sale' ? entry.amount : -entry.amount));
    if (date < from) continue;
    if (entry.type === 'sale') summary.creditSales += entry.amount;
    else if (entry.type === 'collection') summary.collections += entry.amount;
    else if (entry.type === 'refund') summary.creditRefunds += entry.amount;
  }
  const names = new Map((customers ?? []).map(customer => [customer.id, customer]));
  for (const [customerId, balance] of balances) {
    if (balance === 0) continue;
    const customer = names.get(customerId);
    summary.customers.push({customerId, name: customer?.name ?? customerId, phone: customer?.phone ?? '', balance});
    summary.outstanding += Math.max(0, balance);
    summary.advances += Math.max(0, -balance);
  }
  summary.customers.sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));
  return summary;
}

export function isInventoryExpense(expense: Pick<Expense, 'category'>): boolean {
  return /^(stock|inventory|purchases?|ingredients?|raw[ -]?materials?)([ -]purchase)?$/i.test(expense.category.trim());
}

/** Confirmed-bill basis, including credit/unpaid bills. Refunds restate the original bill date.
 * No inventory restock exists on refunds/cancellations, so the consumed cost stays recorded.
 */
export function profitability(data: Pick<Snapshot, 'branch' | 'menu' | 'recipes' | 'inventory' | 'orders' | 'expenses'> & Partial<Pick<Snapshot, 'creditEntries' | 'customers'>> & {stockMovements?:StockMovement[]}, from: string, to = from): ProfitReport {
  const report: ProfitReport = { from, to, wastageCost: 0, netSales: 0, costOfSales: 0, grossProfit: 0, margin: 0, cancelledCost: 0, operatingExpenses: 0, excludedInventoryExpenses: 0, operatingProfit: 0, refundedNetSales: 0, outstanding: 0, loanSummary: summarizeLoans(data.creditEntries, data.customers, data.branch.id, from, to), estimatedLines: 0, missingCostLines: 0, bills: 0, products: [], daily: [] };
  const products = new Map<string, ProductProfit>();
  const days = new Map<string, ProfitReport['daily'][number]>();
  const dayRow = (date: string) => {
    let row = days.get(date);
    if (!row) { row = { date, netSales: 0, costOfSales: 0, cancelledCost: 0, wastageCost: 0, operatingExpenses: 0, operatingProfit: 0 }; days.set(date, row); }
    return row;
  };
  const lineCost = (line: OrderLine) => {
    if (line.unitCost !== undefined && Number.isFinite(line.unitCost) && line.unitCost >= 0) return { unitCost: line.unitCost, estimated: line.costBasis === 'estimated', missing: line.costBasis === 'estimated' };
    const item = data.menu.find(item => item.id === line.menuItemId);
    const cost = item ? productCost(item, data.inventory, data.recipes, data.branch.id) : undefined;
    return { unitCost: cost?.unitCost ?? 0, estimated: true, missing: !cost?.complete };
  };
  for (const order of data.orders) {
    if (order.branchId !== data.branch.id) continue;
    const date = businessDate(order.createdAt);
    if (date < from || date > to) continue;
    const day = dayRow(date);
    const cancelled = order.status === 'cancelled';
    const taxable = Math.max(0, order.subtotal - order.discount);
    const refundedNet = order.total > 0 ? Math.round(Math.min(order.refunded, order.total) * taxable / order.total) : 0;
    const netSales = cancelled ? 0 : Math.max(0, taxable - refundedNet);
    const salesByLine = allocate(netSales, order.lines.map(line => line.lineTotal));
    if (!cancelled) {
      report.bills++;
      report.netSales += netSales;
      report.refundedNetSales += refundedNet;
      report.outstanding += Math.max(0, order.total - order.paid);
      day.netSales += netSales;
    }
    order.lines.forEach((line, index) => {
      const { unitCost, estimated, missing } = lineCost(line);
      const cost = Math.round(unitCost * line.quantity);
      if (estimated) report.estimatedLines++;
      if (missing) report.missingCostLines++;
      if (cancelled) { report.cancelledCost += cost; day.cancelledCost += cost; }
      else { report.costOfSales += cost; day.costOfSales += cost; }
      let product = products.get(line.menuItemId);
      if (!product) { product = { id: line.menuItemId, name: line.name, quantity: 0, netSales: 0, cost: 0, grossProfit: 0, wasteCost: 0, estimated: false }; products.set(line.menuItemId, product); }
      product.estimated ||= estimated;
      if (cancelled) product.wasteCost += cost;
      else { product.quantity += line.quantity; product.netSales += salesByLine[index]; product.cost += cost; }
    });
  }
  for (const expense of data.expenses) {
    if (expense.branchId !== data.branch.id) continue;
    const date = businessDate(expense.createdAt);
    if (date < from || date > to) continue;
    if (isInventoryExpense(expense)) report.excludedInventoryExpenses += expense.amount;
    else { report.operatingExpenses += expense.amount; dayRow(date).operatingExpenses += expense.amount; }
  }
  for (const movement of data.stockMovements ?? []) {
    if (movement.type !== 'waste' || movement.branchId !== data.branch.id) continue;
    const date = businessDate(movement.createdAt);
    if (date < from || date > to) continue;
    const cost = movement.totalCost ?? 0;
    report.wastageCost += cost; dayRow(date).wastageCost += cost;
  }
  report.grossProfit = report.netSales - report.costOfSales;
  report.margin = report.netSales > 0 ? report.grossProfit / report.netSales * 100 : 0;
  report.operatingProfit = report.grossProfit - report.cancelledCost - report.wastageCost - report.operatingExpenses;
  report.products = [...products.values()].map(product => ({ ...product, grossProfit: product.netSales - product.cost })).sort((a, b) => b.grossProfit - a.grossProfit);
  report.daily = [...days.values()].map(day => ({ ...day, operatingProfit: day.netSales - day.costOfSales - day.cancelledCost - day.wastageCost - day.operatingExpenses })).sort((a, b) => a.date.localeCompare(b.date));
  return report;
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  const numeric = /^-?\d+(?:\.\d+)?$/.test(text);
  return `"${(!numeric && /^[=+\-@\t\r]/.test(text) ? "'" : '') + text.replaceAll('"', '""')}"`;
}
export function profitCsv(report: ProfitReport): string {
  const amount = (value: number) => (value / 100).toFixed(2);
  const rows: unknown[][] = [
    ['Profitability - confirmed bill basis; refunds restate original bill date'],
    ['From', report.from, 'To', report.to],
    ['Date (Asia/Colombo)', 'Net sales (LKR)', 'Cost of sales (LKR)', 'Cancelled food cost (LKR)', 'Wastage cost (LKR)', 'Operating expenses (LKR)', 'Operating estimate (LKR)'],
    ...report.daily.map(day => [day.date, amount(day.netSales), amount(day.costOfSales), amount(day.cancelledCost), amount(day.wastageCost), amount(day.operatingExpenses), amount(day.operatingProfit)]),
    ['TOTAL', amount(report.netSales), amount(report.costOfSales), amount(report.cancelledCost), amount(report.wastageCost), amount(report.operatingExpenses), amount(report.operatingProfit)],
    [], ['Product', 'Units', 'Net sales (LKR)', 'Cost (LKR)', 'Gross profit (LKR)', 'Cancelled food cost (LKR)', 'Cost basis'],
    ...report.products.map(product => [product.name, product.quantity, amount(product.netSales), amount(product.cost), amount(product.grossProfit), amount(product.wasteCost), product.estimated ? 'Includes estimates' : 'Captured at sale']),
    [], ['Estimated historical lines', report.estimatedLines], ['Missing cost configuration lines', report.missingCostLines],
    ['Inventory purchase expense entries excluded (LKR)', amount(report.excludedInventoryExpenses)],
    [], ['Customer loans to collect', 'Account balances as of', report.to],
    ...(report.loanSummary ? [
      ['Customer loans outstanding (LKR)', amount(report.loanSummary.outstanding)],
      ['Customer advances (LKR)', amount(report.loanSummary.advances)],
      ['New Customer Loan amounts in period (LKR)', amount(report.loanSummary.creditSales)],
      ['Loan repayments received in period (LKR)', amount(report.loanSummary.collections)],
      ['Credit refunds reducing loans in period (LKR)', amount(report.loanSummary.creditRefunds)],
      [], ['Customer', 'Phone', 'Amount to collect (LKR)', 'Customer advance (LKR)'],
      ...report.loanSummary.customers.map(customer => [customer.name, customer.phone, amount(Math.max(0, customer.balance)), amount(Math.max(0, -customer.balance))]),
      ['Loan basis', 'Outstanding includes older loans through the end date. Repayments are money received, not another sale or additional profit. Credit refunds reduce debt without receiving money. Loan balances include bill tax and service charges; customer advances are shown separately.'],
    ] : [['Loan data', 'Unavailable: customer ledger was not included in this report.']]),
    ['Basis', 'Includes unpaid and credit bills. Excludes tax/service and stock purchases. Food refunds do not restore consumed cost. Other unrecorded costs and stock write-offs are excluded.'],
  ];
  return '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}
