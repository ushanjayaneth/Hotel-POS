export type Role =
  | "owner"
  | "manager"
  | "cashier"
  | "waiter"
  | "kitchen"
  | "storekeeper"
  | "accountant";
export type Locale = "si" | "en";
export type Page =
  | "pos"
  | "overview"
  | "orders"
  | "sales-history"
  | "held-bills"
  | "products"
  | "tables"
  | "kitchen"
  | "inventory"
  | "production"
  | "purchases"
  | "customers"
  | "team"
  | "finance"
  | "reports"
  | "settings";
export interface User {
  id: string;
  name: string;
  role: Role;
  branchId: string | null;
  initials: string;
}
export interface Branch {
  id: string;
  name: string;
  nameSi: string;
  code: string;
  address: string;
  phone: string;
}
export interface Category {
  id: string;
  name: string;
  nameSi: string;
  icon: string;
}
export interface MenuItem {
  id: string;
  name: string;
  nameSi: string;
  description: string;
  categoryId: string;
  price: number;
  cost: number;
  image: string;
  available: boolean;
  enabled?: boolean;
  barcode?: string;
  sku?: string;
  reorderLevel?: number;
  /** Branch-specific sellable quantity derived for register roles; never a stock write input. */
  stockQuantity?: number | null;
  lowStock?: boolean;
  stockMode: "prepared" | "recipe" | "untracked";
  badge?: string;
  preparationMinutes: number;
}
export interface DiningTable {
  id: string;
  branchId: string;
  name: string;
  seats: number;
  area: string;
  status: "available" | "occupied" | "reserved";
  orderId?: string;
}
export type OrderStatus =
  "new" | "preparing" | "ready" | "served" | "completed" | "cancelled";
export interface OrderLine {
  id: string;
  menuItemId: string;
  name: string;
  nameSi: string;
  quantity: number;
  unitPrice: number;
  /** Cost per sold unit, in minor currency units, frozen when the bill is confirmed. */
  unitCost?: number;
  costBasis?: "captured" | "estimated";
  /** Total fixed discount for this line's entire quantity, in minor currency units. */
  discount?: number;
  lineTotal: number;
  note: string;
}
export interface Payment {
  id: string;
  orderId: string;
  method: "cash" | "card" | "qr" | "credit";
  amount: number;
  received: number;
  change: number;
  reference: string;
  createdAt: string;
}
export interface Order {
  id: string;
  number: string;
  branchId: string;
  type: "dine-in" | "takeaway" | "delivery";
  tableId: string | null;
  customerId: string | null;
  status: OrderStatus;
  paymentStatus: "unpaid" | "partial" | "paid" | "refunded";
  subtotal: number;
  /** Combined line discounts and cart discount, deducted once from gross subtotal. */
  discount: number;
  /** Cart-only discount. Legacy bills without this field use discount as their cart discount. */
  cartDiscount?: number;
  tax: number;
  serviceCharge: number;
  total: number;
  paid: number;
  refunded: number;
  note: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  version: number;
  lines: OrderLine[];
  payments: Payment[];
}
export interface InventoryItem {
  id: string;
  branchId: string;
  name: string;
  nameSi: string;
  category: "ingredient" | "prepared" | "packaging" | "resale";
  unit: string;
  quantity: number;
  minimum: number;
  unitCost: number;
  supplierId: string | null;
  menuItemId: string | null;
  updatedAt: string;
}
export interface StockMovement {
  id: string;
  itemId: string;
  branchId: string;
  type: string;
  quantity: number;
  reason: string;
  createdAt: string;
  createdBy: string;
  unitCost?:number;
  totalCost?:number;
}
export interface ProductionBatch {
  id: string;
  branchId: string;
  menuItemId: string;
  name: string;
  quantity: number;
  cost: number;
  note: string;
  createdAt: string;
  createdBy: string;
}
export interface Supplier {
  id: string;
  name: string;
  phone: string;
  email: string;
  balance: number;
}
export interface PurchaseLine {
  itemId: string;
  name: string;
  quantity: number;
  unitCost: number;
  total: number;
}
export interface Purchase {
  id: string;
  branchId: string;
  supplierId: string;
  supplierName: string;
  invoiceNumber: string;
  total: number;
  status: string;
  createdAt: string;
  lines: PurchaseLine[];
}
export interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string;
  visits: number;
  spent: number;
  balance: number;
  points: number;
  createdAt: string;
}
export interface StaffMember extends User {
  active: boolean;
  phone: string;
  lastActive: string | null;
}
export interface Expense {
  id: string;
  branchId: string;
  category: string;
  description: string;
  amount: number;
  paymentMethod: string;
  createdAt: string;
  createdBy: string;
}
export interface Shift {
  id: string;
  branchId: string;
  openedBy: string;
  openedAt: string;
  openingFloat: number;
  status: "open" | "closed";
  closedAt: string | null;
  countedCash: number | null;
  expectedCash: number;
  variance: number | null;
}
export interface AuditEvent {
  id: string;
  branchId: string;
  action: string;
  actor: string;
  detail: string;
  createdAt: string;
}
export interface SyncState {
  configured: boolean;
  pending: number;
  synced: number;
  failed: number;
  lastSync: string | null;
  lastError: string | null;
  lastBackup: string | null;
  hubOnline: boolean;
}
export interface Settings {
  businessName: string;
  tagline: string;
  currency: string;
  taxRate: number;
  serviceChargeRate: number;
  receiptFooter: string;
  lowStockAlerts: boolean;
  autoPrint: boolean;
  language: Locale;
  receiptPaperWidthMm: number;
  receiptContentWidthMm: number;
  receiptMarginMm: number;
  receiptOffsetMm: number;
  receiptFontSize: number;
}
export interface HeldBill {
  id: string;
  branchId: string;
  label: string;
  type: Order["type"];
  tableId: string | null;
  customerId: string | null;
  note: string;
  discount: number;
  lines: CartLine[];
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  status: "held" | "resumed" | "discarded";
  resumedOrderId: string | null;
}
export interface CreditEntry {
  id: string;
  branchId: string;
  customerId: string;
  type: "sale" | "collection" | "refund";
  amount: number;
  method: Payment["method"];
  orderId: string | null;
  reference: string;
  note: string;
  createdAt: string;
  createdBy: string;
}
export interface PrinterDevice {
  id: string;
  name: string;
  driver: string;
  portName: string;
  isDefault: boolean;
  reportedStatus: "ready" | "offline" | "unknown";
  statusDetail: string;
}
export interface PrinterDiscovery {
  printers: PrinterDevice[];
  source: "windows" | "cups" | "unsupported";
  checkedAt: string;
  message: string;
  supported: boolean;
}
export interface NetworkPrinterCheck {
  host: string;
  port: number;
  reachable: boolean;
  latencyMs: number | null;
  checkedAt: string;
  message: string;
}
export interface Recipe {
  id: string;
  /** Editor batch yield only. Ingredient quantities are always stored per portion. */
  batchYield?: number;
  ingredients: { key: string; quantity: number }[];
}
export interface Snapshot {
  user: User;
  branches: Branch[];
  branch: Branch;
  categories: Category[];
  menu: MenuItem[];
  recipes: Recipe[];
  tables: DiningTable[];
  orders: Order[];
  heldBills: HeldBill[];
  creditEntries: CreditEntry[];
  inventory: InventoryItem[];
  stockMovements: StockMovement[];
  production: ProductionBatch[];
  suppliers: Supplier[];
  purchases: Purchase[];
  customers: Customer[];
  staff: StaffMember[];
  expenses: Expense[];
  shifts: Shift[];
  audit: AuditEvent[];
  sync: SyncState;
  settings: Settings;
  serverTime: string;
}
export interface CartLine {
  menuItemId: string;
  quantity: number;
  note: string;
  /** Total fixed discount for the complete product line, in minor currency units. */
  discount?: number;
}
export interface CreateOrderInput {
  commandId: string;
  branchId: string;
  type: Order["type"];
  tableId?: string | null;
  customerId?: string | null;
  heldBillId?: string;
  expectedHeldUpdatedAt?: string;
  note?: string;
  discount?: number;
  lines: CartLine[];
}
export interface MutationResponse {
  ok: boolean;
  order?: Order;
  [key: string]: unknown;
}
