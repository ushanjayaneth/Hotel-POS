import { z } from "zod";
import { productCost } from "../../../shared/costing.js";
import type {
  AuditEvent,
  Branch,
  CreditEntry,
  Customer,
  DiningTable,
  Expense,
  HeldBill,
  InventoryItem,
  MenuItem,
  Order,
  Payment,
  Recipe,
  Role,
  Settings,
  Shift,
  StockMovement,
} from "../../../shared/types.js";
import {
  type LocalRequest,
  now,
  permitLocal,
  requireLocal,
  scopeLocal,
  uid,
} from "./types.js";

const identifier = z.string().min(1).max(160);
const command = z.string().min(8).max(160);
const money = z.number().int().min(0).max(1_000_000_000);
const amount = money.refine(
  (value) => value > 0,
  "Amount must be greater than zero.",
);
const paymentMethod = z.enum(["cash", "card", "qr", "credit"]);
const version = z.number().int().positive();
const sales: Role[] = ["owner", "manager", "cashier", "waiter"];
const financial: Role[] = ["owner", "manager", "cashier", "accountant"];
const management: Role[] = ["owner", "manager"];
const cashiers: Role[] = ["owner", "manager", "cashier"];
const draftSchema = z.object({
  commandId: command.optional(),
  branchId: identifier,
  type: z.enum(["dine-in", "takeaway", "delivery"]),
  tableId: identifier.nullish(),
  customerId: identifier.nullish(),
  note: z.string().max(1000).default(""),
  discount: money.default(0),
  lines: z
    .array(
      z.object({
        menuItemId: identifier,
        quantity: z.number().int().positive().max(1000),
        note: z.string().max(300).default(""),
        discount: money.default(0),
      }),
    )
    .min(1)
    .max(100),
});
type DraftInput = z.infer<typeof draftSchema>;
interface Refund {
  id: string;
  branchId: string;
  orderId: string;
  amount: number;
  method: Payment["method"];
  reason: string;
  createdAt: string;
  createdBy: string;
}

function checkedMoney(
  value: number,
  message = "The calculated amount is invalid.",
) {
  requireLocal(Number.isSafeInteger(value) && value >= 0, message);
  return value;
}
const roundQuantity = (value: number) => Math.round(value * 10000) / 10000;

async function audit(
  request: LocalRequest,
  branchId: string,
  action: string,
  detail: string,
) {
  await request.store.put<AuditEvent>("audit", {
    id: uid("audit"),
    branchId,
    action,
    actor: request.user.name,
    detail,
    createdAt: now(),
  });
}

async function openShift(request: LocalRequest, branchId: string) {
  return (await request.store.list<Shift>("shift", branchId)).find(
    (shift) => shift.status === "open",
  );
}

async function requireShift(request: LocalRequest, branchId: string) {
  const shift = await openShift(request, branchId);
  requireLocal(
    shift,
    "Open a cash shift before recording this transaction.",
    409,
    "SHIFT_REQUIRED",
  );
  checkedMoney(
    shift.expectedCash,
    "The recorded cash drawer balance is invalid.",
  );
  return shift;
}

async function moveCash(request: LocalRequest, shift: Shift, delta: number) {
  const expectedCash = checkedMoney(
    shift.expectedCash + delta,
    "The cash drawer does not contain enough recorded cash.",
  );
  await request.store.put("shift", { ...shift, expectedCash });
}

async function scopedOrder(request: LocalRequest, orderId: string) {
  const order = await request.store.get<Order>("order", orderId);
  requireLocal(order, "Order not found.", 404);
  await scopeLocal(request.store, request.user, order.branchId);
  return order;
}

function checkVersion(order: Order, expectedVersion: number) {
  requireLocal(
    order.version === expectedVersion,
    "This order changed on another device. Refresh before trying again.",
    409,
    "VERSION_CONFLICT",
  );
}

function publicOrder(request: LocalRequest, order: Order): Order {
  if (!["owner", "manager", "accountant"].includes(request.user.role))
    order = { ...order, lines: order.lines.map(({ unitCost: _cost, costBasis: _basis, ...line }) => line) };
  if (request.user.role === "kitchen")
    return {
      ...order,
      customerId: null,
      subtotal: 0,
      discount: 0,
      cartDiscount: 0,
      tax: 0,
      serviceCharge: 0,
      total: 0,
      paid: 0,
      refunded: 0,
      payments: [],
      lines: order.lines.map((line) => ({
        ...line,
        unitPrice: 0,
        discount: 0,
        lineTotal: 0,
      })),
    };
  return request.user.role === "waiter" ? { ...order, payments: [] } : order;
}

async function releaseTable(request: LocalRequest, order: Order) {
  if (!order.tableId) return;
  const table = await request.store.get<DiningTable>("table", order.tableId);
  if (table?.branchId === order.branchId && table.orderId === order.id) {
    const updated = { ...table, status: "available" as const };
    delete updated.orderId;
    await request.store.put("table", updated);
  }
}

async function creditBalance(
  request: LocalRequest,
  customerId: string,
  branchId?: string,
) {
  const balance = (await request.store.list<CreditEntry>("credit", branchId))
    .filter((entry) => entry.customerId === customerId)
    .reduce(
      (sum, entry) =>
        sum + (entry.type === "sale" ? entry.amount : -entry.amount),
      0,
    );
  return checkedMoney(balance, "The customer credit ledger is invalid.");
}

async function moveStock(
  request: LocalRequest,
  stock: InventoryItem,
  quantity: number,
  reason: string,
) {
  requireLocal(
    Number.isFinite(stock.quantity) && stock.quantity >= 0,
    "The recorded stock quantity is invalid.",
    409,
  );
  const delta = -roundQuantity(quantity);
  requireLocal(
    Number.isFinite(delta) && delta < 0,
    "The recipe quantity is invalid.",
    409,
    "INVALID_RECIPE",
  );
  const next = roundQuantity(stock.quantity + delta);
  requireLocal(
    next >= 0,
    `Insufficient ${stock.name}: ${stock.quantity} ${stock.unit} available.`,
    409,
    "INSUFFICIENT_STOCK",
  );
  await request.store.put("inventory", {
    ...stock,
    quantity: next,
    updatedAt: now(),
  });
  await request.store.put<StockMovement>("movement", {
    id: uid("stock"),
    itemId: stock.id,
    branchId: stock.branchId,
    type: "sale",
    quantity: delta,
    reason,
    createdAt: now(),
    createdBy: request.user.id,
  });
}

async function consume(
  request: LocalRequest,
  branchId: string,
  item: MenuItem,
  quantity: number,
  number: string,
) {
  if (item.stockMode === "untracked") return;
  if (item.stockMode === "prepared") {
    const stock = (
      await request.store.list<InventoryItem>("inventory", branchId)
    ).find(
      (candidate) =>
        candidate.menuItemId === item.id &&
        ["prepared", "resale"].includes(candidate.category),
    );
    requireLocal(
      stock,
      `No prepared stock is configured for ${item.name}.`,
      409,
      "STOCK_REQUIRED",
    );
    await moveStock(request, stock, quantity, number);
    return;
  }
  const recipe = await request.store.get<Recipe>("recipe", item.id);
  requireLocal(
    recipe?.ingredients.length,
    `No recipe is configured for ${item.name}.`,
    409,
    "RECIPE_REQUIRED",
  );
  for (const ingredient of recipe.ingredients) {
    requireLocal(
      Number.isFinite(ingredient.quantity) && ingredient.quantity > 0,
      "The recipe quantity is invalid.",
      409,
      "INVALID_RECIPE",
    );
    const prefixed = await request.store.get<InventoryItem>(
      "inventory",
      `${branchId}-${ingredient.key}`,
    );
    const direct =
      prefixed?.branchId === branchId
        ? prefixed
        : await request.store.get<InventoryItem>("inventory", ingredient.key);
    requireLocal(
      direct?.branchId === branchId,
      "Recipe ingredient is missing in this branch.",
      409,
      "INGREDIENT_REQUIRED",
    );
    await moveStock(request, direct, ingredient.quantity * quantity, number);
  }
}

async function validateDraft(
  request: LocalRequest,
  body: DraftInput,
  available = false,
) {
  await scopeLocal(request.store, request.user, body.branchId);
  if (body.discount > 0 || body.lines.some(line => line.discount > 0))
    permitLocal(request.user, management);
  requireLocal(
    body.type === "dine-in" || !body.tableId,
    "A table can only be assigned to a dine-in order.",
  );
  if (body.tableId) {
    const table = await request.store.get<DiningTable>("table", body.tableId);
    requireLocal(
      table?.branchId === body.branchId,
      "Table not found in this branch.",
      404,
    );
    if (available)
      requireLocal(
        table.status === "available",
        "This table already has an active order.",
        409,
        "TABLE_OCCUPIED",
      );
  }
  if (body.customerId)
    requireLocal(
      await request.store.get("customer", body.customerId),
      "Customer not found.",
      404,
    );
  const lines: { input: DraftInput["lines"][number]; item: MenuItem }[] = [];
  let subtotal = 0;
  let itemDiscount = 0;
  for (const input of body.lines) {
    const item = await request.store.get<MenuItem>("menu", input.menuItemId);
    requireLocal(item, "Menu item not found.", 404);
    if (available)
      requireLocal(
        item.enabled ?? item.available,
        "A selected menu item is unavailable.",
        409,
        "ITEM_UNAVAILABLE",
      );
    requireLocal(
      Number.isSafeInteger(item.price) && item.price > 0,
      "A selected menu item has an invalid price.",
      409,
      "INVALID_PRICE",
    );
    const gross = checkedMoney(item.price * input.quantity);
    requireLocal(input.discount <= gross, "A product discount cannot exceed its line amount.");
    subtotal = checkedMoney(subtotal + gross);
    itemDiscount = checkedMoney(itemDiscount + input.discount);
    lines.push({ input, item });
  }
  requireLocal(
    subtotal <= 1_000_000_000,
    "Order subtotal exceeds the allowed limit.",
  );
  requireLocal(
    body.discount <= subtotal - itemDiscount,
    "Cart discount cannot exceed the amount after product discounts.",
  );
  return { lines, subtotal, itemDiscount };
}

async function globalBranch(request: LocalRequest, requested?: string) {
  const branchId =
    requested ??
    request.user.branchId ??
    request.query.get("branchId") ??
    (await request.store.meta<string>("activeBranchId")) ??
    (await request.store.list<Branch>("branch"))[0]?.id;
  requireLocal(branchId, "Select a branch before recording this transaction.");
  await scopeLocal(request.store, request.user, branchId);
  return branchId;
}

async function receiptNumber(request: LocalRequest, branchId: string) {
  const branch = await request.store.get<Branch>("branch", branchId);
  requireLocal(branch, "Branch not found.", 404);
  let deviceId = await request.store.meta<string>("deviceId");
  if (!deviceId) {
    deviceId = uid("device");
    await request.store.setMeta("deviceId", deviceId);
  }
  const day = new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Colombo",
  });
  const key = `receipt:${branchId}:${day}`;
  const sequence =
    Number((await request.store.meta<number | string>(key)) ?? 0) + 1;
  requireLocal(
    Number.isSafeInteger(sequence) && sequence > 0,
    "Receipt sequence is invalid.",
    409,
  );
  await request.store.setMeta(key, sequence);
  return `${branch.code}-${day.replaceAll("-", "")}-${deviceId.replace(/[^a-z0-9]/gi, "").toUpperCase()}-${String(sequence).padStart(4, "0")}`;
}

/** Mutations execute inside the local API's single durable transaction and command journal. */
export async function handleCashier(
  request: LocalRequest,
): Promise<unknown | undefined> {
  const { store, user, method } = request;
  const path = request.path.replace(/^\/api(?=\/)/, "").replace(/\/$/, "");
  if (path === "/orders" && method === "POST") {
    permitLocal(user, sales);
    const body = draftSchema
      .extend({
        heldBillId: identifier.optional(),
        expectedHeldUpdatedAt: z.iso.datetime().optional(),
      })
      .parse(request.body);
    const { lines: priced, subtotal, itemDiscount } = await validateDraft(
      request,
      body,
      true,
    );
    let held: HeldBill | undefined;
    if (body.heldBillId) {
      held = await store.get<HeldBill>("held", body.heldBillId);
      requireLocal(
        held?.branchId === body.branchId,
        "Held bill not found in this branch.",
        404,
      );
      requireLocal(
        held.status === "held",
        "This held bill was already resumed or discarded.",
        409,
        "HELD_BILL_CLOSED",
      );
      requireLocal(
        body.expectedHeldUpdatedAt === held.updatedAt,
        "This held bill changed on another device. Reload it before confirming the order.",
        409,
        "HELD_BILL_CONFLICT",
      );
    }
    const settings = await store.meta<Settings>("settings");
    requireLocal(settings, "Business settings are unavailable.", 409);
    requireLocal(
      Number.isFinite(settings.taxRate) &&
        settings.taxRate >= 0 &&
        settings.taxRate <= 100 &&
        Number.isFinite(settings.serviceChargeRate) &&
        settings.serviceChargeRate >= 0 &&
        settings.serviceChargeRate <= 100,
      "Tax or service charge settings are invalid.",
      409,
    );
    const taxable = subtotal - itemDiscount - body.discount;
    const serviceCharge =
      body.type === "dine-in"
        ? Math.round((taxable * settings.serviceChargeRate) / 100)
        : 0;
    const tax = Math.round(
      ((taxable + serviceCharge) * settings.taxRate) / 100,
    );
    const total = checkedMoney(taxable + serviceCharge + tax);
    requireLocal(
      total <= 1_000_000_000,
      "Order total exceeds the allowed limit.",
    );
    const number = await receiptNumber(request, body.branchId);
    const orderId = uid("order");
    const lines: Order["lines"] = [];
    for (const { input, item } of priced) {
      const cost = productCost(item, await store.list<InventoryItem>("inventory", body.branchId), await store.list<Recipe>("recipe"), body.branchId);
      checkedMoney(cost.unitCost, "The calculated unit cost is invalid.");
      checkedMoney(cost.unitCost * input.quantity, "The calculated line cost is invalid.");
      await consume(request, body.branchId, item, input.quantity, number);
      lines.push({
        id: uid("line"),
        menuItemId: item.id,
        name: item.name,
        nameSi: item.nameSi,
        quantity: input.quantity,
        unitPrice: item.price,
        unitCost: cost.unitCost,
        costBasis: cost.complete ? "captured" : "estimated",
        discount: input.discount,
        lineTotal: item.price * input.quantity - input.discount,
        note: input.note,
      });
    }
    const timestamp = now();
    const order: Order = {
      id: orderId,
      number,
      branchId: body.branchId,
      type: body.type,
      tableId: body.tableId ?? null,
      customerId: body.customerId ?? null,
      status: "new",
      paymentStatus: total === 0 ? "paid" : "unpaid",
      subtotal,
      discount: itemDiscount + body.discount,
      cartDiscount: body.discount,
      tax,
      serviceCharge,
      total,
      paid: 0,
      refunded: 0,
      note: body.note,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: user.id,
      version: 1,
      lines,
      payments: [],
    };
    await store.put("order", order);
    if (held)
      await store.put("held", {
        ...held,
        status: "resumed" as const,
        resumedOrderId: order.id,
        updatedAt: timestamp,
      });
    if (body.tableId) {
      const table = await store.get<DiningTable>("table", body.tableId);
      requireLocal(table, "Table not found.", 404);
      await store.put("table", {
        ...table,
        status: "occupied" as const,
        orderId,
      });
    }
    await audit(
      request,
      body.branchId,
      "order.created",
      `${number} · ${lines.length} items`,
    );
    return { ok: true, order: publicOrder(request, order) };
  }

  const statusMatch = path.match(/^\/orders\/([^/]+)\/status$/);
  if (statusMatch && method === "PATCH") {
    permitLocal(user, [...cashiers, "waiter", "kitchen"]);
    const body = z
      .object({
        commandId: command.optional(),
        expectedVersion: version,
        status: z.enum([
          "new",
          "preparing",
          "ready",
          "served",
          "completed",
          "cancelled",
        ]),
        reason: z.string().trim().max(500).optional(),
      })
      .parse(request.body);
    const order = await scopedOrder(request, statusMatch[1]);
    checkVersion(order, body.expectedVersion);
    const transitions: Record<Order["status"], Order["status"][]> = {
      new: ["preparing", "cancelled"],
      preparing: ["ready", "cancelled"],
      ready: ["served", "completed", "cancelled"],
      served: ["completed", "cancelled"],
      completed: [],
      cancelled: [],
    };
    requireLocal(
      transitions[order.status].includes(body.status),
      "This order status transition is not allowed.",
      409,
      "INVALID_TRANSITION",
    );
    if (user.role === "kitchen")
      requireLocal(
        ["preparing", "ready"].includes(body.status),
        "Kitchen staff can only start preparation or mark orders ready.",
        403,
      );
    if (body.status === "cancelled") {
      permitLocal(user, management);
      requireLocal(
        (body.reason ?? "").length >= 3,
        "Provide a reason for cancelling this order.",
      );
      requireLocal(
        order.paid === order.refunded,
        "Refund all payments before cancelling an order.",
        409,
      );
    }
    if (body.status === "completed")
      requireLocal(
        order.paid - order.refunded >= order.total,
        "An order must be fully paid before completion.",
        409,
        "PAYMENT_REQUIRED",
      );
    const status =
      body.status === "served" &&
      order.type !== "dine-in" &&
      order.paid - order.refunded >= order.total
        ? "completed"
        : body.status;
    const updated: Order = {
      ...order,
      status,
      updatedAt: now(),
      version: order.version + 1,
    };
    await store.put("order", updated);
    // Cancelling cooked food does not replenish sale stock.
    if (["completed", "cancelled"].includes(status))
      await releaseTable(request, updated);
    await audit(
      request,
      order.branchId,
      `order.${status}`,
      `${order.number}${body.reason ? ` · ${body.reason}` : ""}`,
    );
    return { ok: true, order: publicOrder(request, updated) };
  }

  const paymentMatch = path.match(/^\/orders\/([^/]+)\/payments$/);
  if (paymentMatch && method === "POST") {
    permitLocal(user, cashiers);
    const body = z
      .object({
        commandId: command.optional(),
        expectedVersion: version,
        method: paymentMethod,
        amount,
        received: money.optional(),
        reference: z.string().trim().max(200).default(""),
        customerId: identifier.optional(),
      })
      .parse(request.body);
    const order = await scopedOrder(request, paymentMatch[1]);
    checkVersion(order, body.expectedVersion);
    requireLocal(
      !["cancelled", "completed"].includes(order.status),
      "This order is closed.",
      409,
    );
    const due = checkedMoney(order.total - order.paid);
    requireLocal(
      body.amount <= due,
      "Payment exceeds the outstanding balance.",
      409,
      "OVERPAYMENT",
    );
    requireLocal(
      order.refunded === 0,
      "A refunded order cannot accept new payments.",
      409,
    );
    const shift = await requireShift(request, order.branchId);
    const received = body.received ?? body.amount;
    requireLocal(
      body.method !== "cash" || received >= body.amount,
      "Cash received is less than the payment amount.",
    );
    requireLocal(
      body.method === "cash" || received === body.amount,
      "Received amount must equal the payment for non-cash methods.",
    );
    if (["card", "qr"].includes(body.method))
      requireLocal(
        body.reference,
        "Record the approved terminal or bank reference. This system does not charge cards.",
      );
    requireLocal(
      body.customerId === undefined || body.method === "credit",
      "A customer can only be selected here for a Customer Loan.",
    );
    const customerId = body.method === "credit"
      ? body.customerId ?? order.customerId
      : order.customerId;
    if (body.method === "credit")
      requireLocal(customerId, "Select a customer for a Customer Loan.");
    const customer = customerId
      ? await store.get<Customer>("customer", customerId)
      : undefined;
    if (customerId) requireLocal(customer, "Customer not found.", 404);
    if (body.method === "credit" && customerId !== order.customerId) {
      const financialHistory = order.payments.length > 0 || order.paid > 0 || order.refunded > 0 ||
        (await store.list<CreditEntry>("credit", order.branchId)).some(entry => entry.orderId === order.id) ||
        (await store.list<Refund>("refund", order.branchId)).some(refund => refund.orderId === order.id);
      requireLocal(
        !financialHistory,
        "The customer cannot be changed after a payment or Customer Loan has been recorded.",
        409,
        "CUSTOMER_LOCKED",
      );
    }
    const timestamp = now();
    const payment: Payment = {
      id: uid("payment"),
      orderId: order.id,
      method: body.method,
      amount: body.amount,
      received,
      change: body.method === "cash" ? received - body.amount : 0,
      reference: body.reference,
      createdAt: timestamp,
    };
    const paid = checkedMoney(order.paid + body.amount);
    const updated: Order = {
      ...order,
      customerId,
      paid,
      paymentStatus: paid === order.total ? "paid" : "partial",
      payments: [...order.payments, payment],
      updatedAt: timestamp,
      version: order.version + 1,
    };
    // Prepayment never removes an unserved takeaway from the kitchen queue.
    if (
      paid === order.total &&
      order.type !== "dine-in" &&
      order.status === "served"
    )
      updated.status = "completed";
    await store.put("order", updated);
    if (body.method === "cash") await moveCash(request, shift, body.amount);
    if (body.method === "credit" && customer)
      await store.put<CreditEntry>("credit", {
        id: `credit-${payment.id}`,
        branchId: order.branchId,
        customerId: customer.id,
        orderId: order.id,
        type: "sale",
        amount: body.amount,
        method: "credit",
        reference: payment.reference,
        note: `Credit sale ${order.number}`,
        createdAt: timestamp,
        createdBy: user.id,
      });
    if (customer)
      await store.put("customer", {
        ...customer,
        spent: checkedMoney(customer.spent + body.amount),
        visits: customer.visits + (paid === order.total ? 1 : 0),
        balance: await creditBalance(request, customer.id),
        points: customer.points + Math.floor(body.amount / 10000),
      });
    if (updated.status === "completed") await releaseTable(request, updated);
    await audit(
      request,
      order.branchId,
      "payment.accepted",
      `${order.number} · ${body.method} · ${body.amount}`,
    );
    return { ok: true, order: publicOrder(request, updated), payment };
  }

  const refundMatch = path.match(/^\/orders\/([^/]+)\/refunds$/);
  if (refundMatch && method === "POST") {
    permitLocal(user, management);
    const body = z
      .object({
        commandId: command.optional(),
        expectedVersion: version,
        amount,
        reason: z.string().trim().min(3).max(500),
        method: paymentMethod.optional(),
      })
      .parse(request.body);
    const order = await scopedOrder(request, refundMatch[1]);
    checkVersion(order, body.expectedVersion);
    requireLocal(
      body.amount <= order.paid - order.refunded,
      "Refund exceeds the unrefunded paid amount.",
    );
    const method = body.method ?? order.payments[0]?.method ?? "cash";
    const shift = await requireShift(request, order.branchId);
    const previous = (await store.list<Refund>("refund", order.branchId))
      .filter(
        (refund) => refund.orderId === order.id && refund.method === method,
      )
      .reduce((sum, refund) => sum + refund.amount, 0);
    const paidByMethod = order.payments
      .filter((payment) => payment.method === method)
      .reduce((sum, payment) => sum + payment.amount, 0);
    requireLocal(
      body.amount <= paidByMethod - previous,
      "Refund exceeds the payment received by this method.",
    );
    if (method === "credit")
      requireLocal(
        order.customerId &&
          body.amount <=
            (await creditBalance(request, order.customerId, order.branchId)),
        "This credit balance has already been collected; reconcile the actual payment before refunding.",
        409,
        "CREDIT_ALREADY_COLLECTED",
      );
    if (method === "cash") await moveCash(request, shift, -body.amount);
    const timestamp = now();
    const refund: Refund = {
      id: uid("refund"),
      branchId: order.branchId,
      orderId: order.id,
      amount: body.amount,
      method,
      reason: body.reason,
      createdAt: timestamp,
      createdBy: user.id,
    };
    await store.put("refund", refund);
    if (method === "credit" && order.customerId)
      await store.put<CreditEntry>("credit", {
        id: `credit-${refund.id}`,
        branchId: order.branchId,
        customerId: order.customerId,
        orderId: order.id,
        type: "refund",
        amount: body.amount,
        method: "credit",
        reference: "",
        note: body.reason,
        createdAt: timestamp,
        createdBy: user.id,
      });
    const refunded = checkedMoney(order.refunded + body.amount);
    const updated: Order = {
      ...order,
      refunded,
      paymentStatus: refunded === order.paid ? "refunded" : "partial",
      updatedAt: timestamp,
      version: order.version + 1,
    };
    await store.put("order", updated);
    if (order.customerId) {
      const customer = await store.get<Customer>("customer", order.customerId);
      requireLocal(customer, "Customer not found.", 404);
      await store.put("customer", {
        ...customer,
        spent: Math.max(0, customer.spent - body.amount),
        balance: await creditBalance(request, customer.id),
        points: Math.max(0, customer.points - Math.floor(body.amount / 10000)),
      });
    }
    await audit(
      request,
      order.branchId,
      "payment.refunded",
      `${order.number} · ${body.amount} · ${body.reason}`,
    );
    return { ok: true, order: publicOrder(request, updated), refund };
  }

  const heldMatch = path.match(/^\/held-bills\/([^/]+)$/);
  if (
    (path === "/held-bills" && method === "POST") ||
    (heldMatch && method === "PUT")
  ) {
    permitLocal(user, sales);
    const body = draftSchema
      .extend({
        label: z.string().trim().min(1).max(100).default("Held bill"),
        expectedUpdatedAt: z.iso.datetime().optional(),
      })
      .parse(request.body);
    await validateDraft(request, body);
    const current = heldMatch
      ? await store.get<HeldBill>("held", heldMatch[1])
      : undefined;
    if (heldMatch) {
      requireLocal(
        current?.branchId === body.branchId,
        "Held bill not found in this branch.",
        404,
      );
      requireLocal(
        current.status === "held",
        "This held bill has already been resumed or discarded.",
        409,
        "HELD_BILL_CLOSED",
      );
      requireLocal(
        body.expectedUpdatedAt === current.updatedAt,
        "This held bill changed on another device. Reload it before saving.",
        409,
        "HELD_BILL_CONFLICT",
      );
    }
    const timestamp = current
      ? new Date(
          Math.max(Date.now(), Date.parse(current.updatedAt) + 1),
        ).toISOString()
      : now();
    const heldBill: HeldBill = {
      id: current?.id ?? uid("held"),
      branchId: body.branchId,
      label: body.label,
      type: body.type,
      tableId: body.tableId ?? null,
      customerId: body.customerId ?? null,
      note: body.note,
      discount: body.discount,
      lines: body.lines,
      status: "held",
      resumedOrderId: null,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
      createdBy: current?.createdBy ?? user.id,
    };
    await store.put("held", heldBill);
    await audit(
      request,
      body.branchId,
      current ? "bill.updated" : "bill.held",
      heldBill.label,
    );
    return { ok: true, heldBill };
  }
  if (heldMatch && method === "DELETE") {
    permitLocal(user, sales);
    z.object({ commandId: command.optional() }).parse(request.body);
    const current = await store.get<HeldBill>("held", heldMatch[1]);
    requireLocal(current, "Held bill not found.", 404);
    await scopeLocal(store, user, current.branchId);
    requireLocal(
      current.status === "held",
      "This held bill has already been resumed or discarded.",
      409,
      "HELD_BILL_CLOSED",
    );
    await store.put("held", {
      ...current,
      status: "discarded" as const,
      updatedAt: now(),
    });
    await audit(request, current.branchId, "bill.discarded", current.label);
    return { ok: true };
  }

  if (path === "/shifts/open" && method === "POST") {
    permitLocal(user, cashiers);
    const body = z
      .object({
        commandId: command.optional(),
        branchId: identifier,
        openingFloat: money,
      })
      .parse(request.body);
    await scopeLocal(store, user, body.branchId);
    requireLocal(
      !(await openShift(request, body.branchId)),
      "A cash shift is already open in this branch.",
      409,
      "SHIFT_ALREADY_OPEN",
    );
    const shift: Shift = {
      id: uid("shift"),
      branchId: body.branchId,
      openedBy: user.id,
      openedAt: now(),
      openingFloat: body.openingFloat,
      status: "open",
      closedAt: null,
      countedCash: null,
      expectedCash: body.openingFloat,
      variance: null,
    };
    await store.put("shift", shift);
    await audit(
      request,
      body.branchId,
      "shift.opened",
      `Opening float ${body.openingFloat}`,
    );
    return { ok: true, shift };
  }
  const closeMatch = path.match(/^\/shifts\/([^/]+)\/close$/);
  if (closeMatch && method === "POST") {
    permitLocal(user, cashiers);
    const body = z
      .object({ commandId: command.optional(), countedCash: money })
      .parse(request.body);
    const shift = await store.get<Shift>("shift", closeMatch[1]);
    requireLocal(shift, "Shift not found.", 404);
    await scopeLocal(store, user, shift.branchId);
    requireLocal(
      shift.status === "open",
      "This shift is already closed.",
      409,
      "SHIFT_CLOSED",
    );
    checkedMoney(
      shift.expectedCash,
      "The recorded cash drawer balance is invalid.",
    );
    const updated: Shift = {
      ...shift,
      status: "closed",
      closedAt: now(),
      countedCash: body.countedCash,
      variance: body.countedCash - shift.expectedCash,
    };
    await store.put("shift", updated);
    await audit(
      request,
      shift.branchId,
      "shift.closed",
      `Cash variance ${updated.variance}`,
    );
    return { ok: true, shift: updated };
  }

  if (path === "/expenses" && method === "POST") {
    permitLocal(user, financial);
    const body = z
      .object({
        commandId: command.optional(),
        branchId: identifier,
        category: z.string().trim().min(2).max(80),
        description: z.string().trim().min(3).max(500),
        amount,
        paymentMethod: z.enum(["cash", "card", "bank", "qr"]),
      })
      .parse(request.body);
    await scopeLocal(store, user, body.branchId);
    if (body.paymentMethod === "cash")
      await moveCash(
        request,
        await requireShift(request, body.branchId),
        -body.amount,
      );
    const expense: Expense = {
      id: uid("expense"),
      branchId: body.branchId,
      category: body.category,
      description: body.description,
      amount: body.amount,
      paymentMethod: body.paymentMethod,
      createdAt: now(),
      createdBy: user.id,
    };
    await store.put("expense", expense);
    await audit(
      request,
      body.branchId,
      "expense.recorded",
      `${body.description} · ${body.amount}`,
    );
    return { ok: true, expense };
  }

  if (path === "/customers" && method === "POST") {
    permitLocal(user, sales);
    const body = z
      .object({
        commandId: command.optional(),
        branchId: identifier.optional(),
        name: z.string().trim().min(2).max(120),
        phone: z.string().trim().min(5).max(30),
        email: z.union([z.email(), z.literal("")]).default(""),
      })
      .parse(request.body);
    const branchId = await globalBranch(request, body.branchId);
    const phone = body.phone.replace(/[^\d+]/g, "");
    requireLocal(
      phone.replace(/\D/g, "").length >= 5,
      "Enter a valid customer phone number.",
    );
    requireLocal(
      !(await store.list<Customer>("customer")).some(
        (customer) => customer.phone.replace(/[^\d+]/g, "") === phone,
      ),
      "A customer with this phone number already exists.",
      409,
      "DUPLICATE_CUSTOMER",
    );
    const customer: Customer = {
      id: uid("customer"),
      name: body.name,
      phone: body.phone,
      email: body.email,
      visits: 0,
      spent: 0,
      balance: 0,
      points: 0,
      createdAt: now(),
    };
    await store.put("customer", customer);
    await audit(request, branchId, "customer.created", customer.name);
    return { ok: true, customer };
  }
  const collectionMatch = path.match(/^\/customers\/([^/]+)\/collections$/);
  if (collectionMatch && method === "POST") {
    permitLocal(user, financial);
    const body = z
      .object({
        commandId: command.optional(),
        branchId: identifier,
        amount,
        method: z.enum(["cash", "card", "qr"]),
        reference: z.string().trim().max(200).default(""),
        note: z.string().max(500).default(""),
      })
      .parse(request.body);
    await scopeLocal(store, user, body.branchId);
    const customer = await store.get<Customer>("customer", collectionMatch[1]);
    requireLocal(customer, "Customer not found.", 404);
    const balance = await creditBalance(request, customer.id, body.branchId);
    requireLocal(
      body.amount <= balance,
      "Collection exceeds this customer's outstanding balance in this branch.",
      409,
      "COLLECTION_EXCEEDS_BALANCE",
    );
    if (body.method === "cash")
      await moveCash(
        request,
        await requireShift(request, body.branchId),
        body.amount,
      );
    else
      requireLocal(
        body.reference,
        "Record the approved terminal or bank reference. This system does not charge cards.",
      );
    const entry: CreditEntry = {
      id: uid("credit"),
      branchId: body.branchId,
      customerId: customer.id,
      orderId: null,
      type: "collection",
      amount: body.amount,
      method: body.method,
      reference: body.reference,
      note: body.note,
      createdAt: now(),
      createdBy: user.id,
    };
    await store.put("credit", entry);
    await store.put("customer", {
      ...customer,
      balance: await creditBalance(request, customer.id),
    });
    await audit(
      request,
      body.branchId,
      "credit.collected",
      `${customer.name} · ${body.amount} · ${body.method}`,
    );
    return { ok: true, entry, balance: balance - body.amount };
  }
  return undefined;
}
