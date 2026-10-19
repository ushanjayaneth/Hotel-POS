import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type {
  Branch,
  CreditEntry,
  Customer,
  DiningTable,
  HeldBill,
  InventoryItem,
  MenuItem,
  Order,
  Recipe,
  Settings,
  Shift,
  User,
} from "../shared/types";
import { LocalDatabase, LocalStore } from "../src/lib/local/db";
import { handleCashier } from "../src/lib/local/cashier";

const owner: User = {
  id: "owner",
  name: "Owner",
  role: "owner",
  branchId: null,
  initials: "OW",
};
const settings: Settings = {
  businessName: "Test restaurant",
  tagline: "Kitchen",
  currency: "LKR",
  taxRate: 5,
  serviceChargeRate: 10,
  receiptFooter: "Thank you",
  lowStockAlerts: true,
  autoPrint: false,
  language: "en",
  receiptPaperWidthMm: 80,
  receiptContentWidthMm: 72,
  receiptMarginMm: 2,
  receiptOffsetMm: 0,
  receiptFontSize: 10,
};
const product = (
  id: string,
  stockMode: MenuItem["stockMode"],
  price: number,
): MenuItem => ({
  id,
  name: id,
  nameSi: id,
  description: "",
  categoryId: "food",
  price,
  cost: 1000,
  image: "/images/curry.jpg",
  available: true,
  stockMode,
  preparationMinutes: 5,
});

async function fixture(deviceId = "device-a") {
  const db = new LocalDatabase(`cashier-test-${randomUUID()}`);
  const store = new LocalStore(db);
  for (const id of ["b1", "b2"])
    await store.put<Branch>("branch", {
      id,
      name: id,
      nameSi: id,
      code: id.toUpperCase(),
      address: "",
      phone: "",
    });
  await store.setMeta("settings", settings);
  await store.setMeta("deviceId", deviceId);
  await store.setMeta("activeBranchId", "b1");
  await store.put("menu", product("rice", "prepared", 10000));
  await store.put("menu", product("noodles", "recipe", 20000));
  await store.put("menu", product("bottle", "prepared", 5000));
  await store.put("menu", product("service", "untracked", 3000));
  const stocks: [string, string | null, InventoryItem["category"], number][] = [
    ["rice-stock", "rice", "prepared", 10],
    ["bottle-stock", "bottle", "resale", 10],
    ["flour", null, "ingredient", 10],
    ["sauce", null, "ingredient", 1],
  ];
  for (const [key, menuItemId, category, quantity] of stocks)
    await store.put<InventoryItem>("inventory", {
      id: `b1-${key}`,
      branchId: "b1",
      name: key,
      nameSi: key,
      category,
      unit: "unit",
      quantity,
      minimum: 0,
      unitCost: 1000,
      supplierId: null,
      menuItemId,
      updatedAt: new Date().toISOString(),
    });
  await store.put<Recipe>("recipe", {
    id: "noodles",
    ingredients: [
      { key: "flour", quantity: 0.25 },
      { key: "sauce", quantity: 0.1 },
    ],
  });
  await store.put<DiningTable>("table", {
    id: "table-1",
    branchId: "b1",
    name: "Table 1",
    seats: 4,
    area: "Main",
    status: "available",
  });
  await store.put<Customer>("customer", {
    id: "customer-1",
    name: "Guest One",
    phone: "0771234567",
    email: "",
    visits: 0,
    spent: 0,
    points: 0,
    balance: 0,
    createdAt: new Date().toISOString(),
  });
  const run = async <T = any>(
    path: string,
    body: unknown,
    method = "POST",
    user = owner,
  ): Promise<T> =>
    db.transaction("rw", db.tables, async () =>
      handleCashier({
        path,
        method,
        body: { commandId: randomUUID(), ...(body as object) },
        query: new URLSearchParams(),
        user,
        store: new LocalStore(db),
      }),
    ) as Promise<T>;
  const order = async (changes: Record<string, unknown> = {}) =>
    (
      await run<{ order: Order }>("/orders", {
        branchId: "b1",
        type: "takeaway",
        lines: [{ menuItemId: "rice", quantity: 1 }],
        ...changes,
      })
    ).order;
  const shift = async (openingFloat = 100000) =>
    (
      await run<{ shift: Shift }>("/shifts/open", {
        branchId: "b1",
        openingFloat,
      })
    ).shift;
  return { db, store, run, order, shift, close: () => db.delete() };
}

test("local sales use catalogue prices, consume prepared/resale/recipe stock, and roll back failed transactions", async () => {
  const f = await fixture();
  try {
    const order = await f.order({
      type: "dine-in",
      tableId: "table-1",
      discount: 1000,
      lines: [
        { menuItemId: "rice", quantity: 2, unitPrice: 1 },
        { menuItemId: "noodles", quantity: 2 },
        { menuItemId: "bottle", quantity: 1 },
      ],
    });
    assert.equal(order.subtotal, 65000);
    assert.equal(order.serviceCharge, 6400);
    assert.equal(order.tax, 3520);
    assert.equal(order.total, 73920);
    assert.equal(order.lines[0].unitPrice, 10000);
    assert.match(order.number, /^B1-\d{8}-DEVICEA-0001$/);
    assert.equal(
      (await f.store.get<InventoryItem>("inventory", "b1-rice-stock"))!
        .quantity,
      8,
    );
    assert.equal(
      (await f.store.get<InventoryItem>("inventory", "b1-bottle-stock"))!
        .quantity,
      9,
    );
    assert.equal(
      (await f.store.get<InventoryItem>("inventory", "b1-flour"))!.quantity,
      9.5,
    );
    assert.equal(
      (await f.store.get<InventoryItem>("inventory", "b1-sauce"))!.quantity,
      0.8,
    );
    assert.equal(
      (await f.store.get<DiningTable>("table", "table-1"))!.orderId,
      order.id,
    );
    const records = await f.db.records.toArray();
    const metadata = await f.db.metadata.toArray();
    // Prepared stock and the first recipe ingredient are written before sauce runs out.
    await assert.rejects(
      f.order({
        lines: [
          { menuItemId: "rice", quantity: 1 },
          { menuItemId: "noodles", quantity: 9 },
        ],
      }),
      { code: "INSUFFICIENT_STOCK" },
    );
    assert.deepEqual(await f.db.records.toArray(), records);
    assert.deepEqual(await f.db.metadata.toArray(), metadata);
    assert.equal((await f.store.list<Order>("order")).length, 1);
    f.db.close();
    await f.db.open();
    assert.equal((await f.store.get<Order>("order", order.id))!.total, 73920);
  } finally {
    await f.close();
  }
});

test("local cash payments retain prepaid takeaway in the kitchen until handoff and reconcile expenses/refunds/day end", async () => {
  const f = await fixture();
  try {
    const shift = await f.shift();
    let order = await f.order();
    const payment = await f.run("/orders/" + order.id + "/payments", {
      expectedVersion: order.version,
      method: "cash",
      amount: order.total,
      received: 20000,
    });
    order = payment.order;
    assert.equal(payment.payment.change, 9500);
    assert.equal(order.paymentStatus, "paid");
    assert.equal(order.status, "new");
    for (const status of ["preparing", "ready"])
      order = (
        await f.run(
          `/orders/${order.id}/status`,
          { expectedVersion: order.version, status },
          "PATCH",
        )
      ).order;
    assert.equal(order.status, "ready");
    order = (
      await f.run(
        `/orders/${order.id}/status`,
        { expectedVersion: order.version, status: "served" },
        "PATCH",
      )
    ).order;
    assert.equal(order.status, "completed");
    await f.run("/expenses", {
      branchId: "b1",
      category: "Travel",
      description: "Delivery fuel",
      amount: 2500,
      paymentMethod: "cash",
    });
    order = (
      await f.run(`/orders/${order.id}/refunds`, {
        expectedVersion: order.version,
        amount: 2000,
        method: "cash",
        reason: "Guest adjustment",
      })
    ).order;
    assert.equal(order.refunded, 2000);
    const expected = 100000 + 10500 - 2500 - 2000;
    assert.equal(
      (await f.store.get<Shift>("shift", shift.id))!.expectedCash,
      expected,
    );
    const closed = (
      await f.run(`/shifts/${shift.id}/close`, { countedCash: expected - 100 })
    ).shift;
    assert.equal(closed.variance, -100);
    const unpaid = await f.order();
    await assert.rejects(
      f.run(`/orders/${unpaid.id}/payments`, {
        expectedVersion: 1,
        method: "cash",
        amount: unpaid.total,
      }),
      { code: "SHIFT_REQUIRED" },
    );
  } finally {
    await f.close();
  }
});

test("local customer credit and later collections preserve sales totals and limit refunds to outstanding dues", async () => {
  const f = await fixture();
  try {
    const shift = await f.shift();
    let order = await f.order({ customerId: "customer-1" });
    order = (
      await f.run(`/orders/${order.id}/payments`, {
        expectedVersion: order.version,
        method: "credit",
        amount: order.total,
      })
    ).order;
    assert.equal(
      (await f.store.get<Shift>("shift", shift.id))!.expectedCash,
      100000,
    );
    assert.equal(
      (await f.store.get<Customer>("customer", "customer-1"))!.balance,
      10500,
    );
    const collected = await f.run("/customers/customer-1/collections", {
      branchId: "b1",
      method: "cash",
      amount: 4000,
    });
    assert.equal(collected.balance, 6500);
    assert.equal(
      (await f.store.get<Customer>("customer", "customer-1"))!.spent,
      10500,
    );
    await assert.rejects(
      f.run(`/orders/${order.id}/refunds`, {
        expectedVersion: order.version,
        method: "credit",
        amount: 6501,
        reason: "Returned purchase",
      }),
      { code: "CREDIT_ALREADY_COLLECTED" },
    );
    order = (
      await f.run(`/orders/${order.id}/refunds`, {
        expectedVersion: order.version,
        method: "credit",
        amount: 1500,
        reason: "Returned purchase",
      })
    ).order;
    assert.equal(
      (await f.store.get<Customer>("customer", "customer-1"))!.balance,
      5000,
    );
    const before = await f.db.records.toArray();
    await assert.rejects(
      f.run("/customers/customer-1/collections", {
        branchId: "b1",
        method: "cash",
        amount: 5001,
      }),
      { code: "COLLECTION_EXCEEDS_BALANCE" },
    );
    assert.deepEqual(await f.db.records.toArray(), before);
    await f.run("/customers/customer-1/collections", {
      branchId: "b1",
      method: "card",
      amount: 5000,
      reference: "Approved external terminal 456",
    });
    assert.equal(
      (await f.store.get<Customer>("customer", "customer-1"))!.balance,
      0,
    );
    assert.equal(
      (await f.store.get<Customer>("customer", "customer-1"))!.spent,
      9000,
    );
    assert.equal(
      (await f.store.get<Shift>("shift", shift.id))!.expectedCash,
      104000,
    );
    assert.equal((await f.store.list<CreditEntry>("credit")).length, 4);
  } finally {
    await f.close();
  }
});

test("dine-in tables release only on paid completion or cancellation, and cancellation keeps cooked stock consumed", async () => {
  const f = await fixture();
  try {
    await f.shift();
    let order = await f.order({ type: "dine-in", tableId: "table-1" });
    const kitchen: User = {
      ...owner,
      id: "cook",
      role: "kitchen",
      branchId: "b1",
    };
    for (const status of ["preparing", "ready"]) {
      const response = await f.run(
        `/orders/${order.id}/status`,
        { expectedVersion: order.version, status },
        "PATCH",
        kitchen,
      );
      assert.equal(response.order.total, 0);
      order = (await f.store.get<Order>("order", order.id))!;
    }
    await assert.rejects(
      f.run(
        `/orders/${order.id}/status`,
        { expectedVersion: order.version, status: "completed" },
        "PATCH",
      ),
      { code: "PAYMENT_REQUIRED" },
    );
    assert.equal(
      (await f.store.get<DiningTable>("table", "table-1"))!.status,
      "occupied",
    );
    order = (
      await f.run(`/orders/${order.id}/payments`, {
        expectedVersion: order.version,
        method: "cash",
        amount: order.total,
      })
    ).order;
    assert.equal(order.status, "ready");
    await f.run(
      `/orders/${order.id}/status`,
      { expectedVersion: order.version, status: "completed" },
      "PATCH",
    );
    const released = (await f.store.get<DiningTable>("table", "table-1"))!;
    assert.equal(released.status, "available");
    assert.equal(released.orderId, undefined);
    const next = await f.order({ type: "dine-in", tableId: "table-1" });
    const beforeCancel = (await f.store.get<InventoryItem>(
      "inventory",
      "b1-rice-stock",
    ))!.quantity;
    await f.run(
      `/orders/${next.id}/status`,
      {
        expectedVersion: next.version,
        status: "cancelled",
        reason: "Guest cancelled after cooking",
      },
      "PATCH",
    );
    assert.equal(
      (await f.store.get<DiningTable>("table", "table-1"))!.status,
      "available",
    );
    assert.equal(
      (await f.store.get<InventoryItem>("inventory", "b1-rice-stock"))!
        .quantity,
      beforeCancel,
    );
  } finally {
    await f.close();
  }
});

test("held bills reserve no stock, reject stale updates, resume once, and survive a reload", async () => {
  const f = await fixture();
  try {
    const draft = {
      branchId: "b1",
      label: "Guest table",
      type: "dine-in",
      tableId: "table-1",
      lines: [{ menuItemId: "rice", quantity: 2 }],
    };
    let held = (await f.run<{ heldBill: HeldBill }>("/held-bills", draft))
      .heldBill;
    assert.equal(
      (await f.store.get<InventoryItem>("inventory", "b1-rice-stock"))!
        .quantity,
      10,
    );
    assert.equal(
      (await f.store.get<DiningTable>("table", "table-1"))!.status,
      "available",
    );
    const old = held.updatedAt;
    held = (
      await f.run(
        `/held-bills/${held.id}`,
        {
          ...draft,
          expectedUpdatedAt: old,
          lines: [{ menuItemId: "rice", quantity: 3 }],
        },
        "PUT",
      )
    ).heldBill;
    assert.ok(held.updatedAt > old);
    await assert.rejects(
      f.run(
        `/held-bills/${held.id}`,
        { ...draft, expectedUpdatedAt: old },
        "PUT",
      ),
      { code: "HELD_BILL_CONFLICT" },
    );
    await assert.rejects(
      f.order({ ...draft, heldBillId: held.id, expectedHeldUpdatedAt: old }),
      { code: "HELD_BILL_CONFLICT" },
    );
    f.db.close();
    await f.db.open();
    assert.equal(
      (await f.store.get<HeldBill>("held", held.id))!.lines[0].quantity,
      3,
    );
    const order = await f.order({
      ...draft,
      lines: held.lines,
      heldBillId: held.id,
      expectedHeldUpdatedAt: held.updatedAt,
    });
    assert.equal(order.lines[0].quantity, 3);
    assert.equal(
      (await f.store.get<InventoryItem>("inventory", "b1-rice-stock"))!
        .quantity,
      7,
    );
    await assert.rejects(
      f.order({
        ...draft,
        tableId: null,
        heldBillId: held.id,
        expectedHeldUpdatedAt: held.updatedAt,
      }),
      { code: "HELD_BILL_CLOSED" },
    );
    const other = (await f.run("/held-bills", { ...draft, tableId: null }))
      .heldBill;
    await f.run(`/held-bills/${other.id}`, {}, "DELETE");
    assert.equal(
      (await f.store.get<HeldBill>("held", other.id))!.status,
      "discarded",
    );
  } finally {
    await f.close();
  }
});

test("local role, branch, version, payment-method and numeric guards reject unsafe writes", async () => {
  const f = await fixture();
  try {
    const cashier: User = {
      ...owner,
      id: "cashier",
      role: "cashier",
      branchId: "b1",
    };
    const waiter: User = { ...cashier, id: "waiter", role: "waiter" };
    await assert.rejects(
      f.run(
        "/orders",
        {
          branchId: "b2",
          type: "takeaway",
          lines: [{ menuItemId: "rice", quantity: 1 }],
        },
        "POST",
        cashier,
      ),
      { code: "BRANCH_FORBIDDEN" },
    );
    await assert.rejects(
      f.run(
        "/orders",
        {
          branchId: "b1",
          type: "takeaway",
          discount: 1,
          lines: [{ menuItemId: "rice", quantity: 1 }],
        },
        "POST",
        cashier,
      ),
      { code: "FORBIDDEN" },
    );
    await assert.rejects(
      f.order({ lines: [{ menuItemId: "rice", quantity: Infinity }] }),
    );
    await assert.rejects(f.order({ discount: 10000 }));
    assert.equal((await f.store.list<Order>("order")).length, 0);
    const shift = await f.shift();
    const order = await f.order();
    await assert.rejects(
      f.run(`/orders/${order.id}/payments`, {
        expectedVersion: 2,
        method: "cash",
        amount: 1,
      }),
      { code: "VERSION_CONFLICT" },
    );
    await assert.rejects(
      f.run(
        `/orders/${order.id}/payments`,
        { expectedVersion: 1, method: "cash", amount: 1 },
        "POST",
        waiter,
      ),
      { code: "FORBIDDEN" },
    );
    await assert.rejects(
      f.run(`/orders/${order.id}/payments`, {
        expectedVersion: 1,
        method: "cash",
        amount: order.total + 1,
      }),
      { code: "OVERPAYMENT" },
    );
    await assert.rejects(
      f.run(`/orders/${order.id}/payments`, {
        expectedVersion: 1,
        method: "card",
        amount: order.total,
      }),
    );
    await assert.rejects(
      f.run(`/orders/${order.id}/payments`, {
        expectedVersion: 1,
        method: "credit",
        amount: order.total,
      }),
    );
    await assert.rejects(
      f.run("/expenses", {
        branchId: "b1",
        category: "Travel",
        description: "Too much cash",
        amount: 100001,
        paymentMethod: "cash",
      }),
    );
    assert.equal(
      (await f.store.get<Shift>("shift", shift.id))!.expectedCash,
      100000,
    );
    assert.equal((await f.store.get<Order>("order", order.id))!.paid, 0);
    assert.equal((await f.store.list("expense")).length, 0);
    const customer = (
      await f.run("/customers", { name: "Second Guest", phone: "077 765 4321" })
    ).customer;
    await assert.rejects(
      f.run("/customers", { name: "Duplicate Guest", phone: "0777654321" }),
      { code: "DUPLICATE_CUSTOMER" },
    );
    assert.ok(customer.id);
    const paid = (
      await f.run(`/orders/${order.id}/payments`, {
        expectedVersion: 1,
        method: "qr",
        amount: order.total,
        reference: "Verified bank transfer",
      })
    ).order;
    assert.equal(paid.paymentStatus, "paid");
    assert.equal(
      (await f.store.get<Shift>("shift", shift.id))!.expectedCash,
      100000,
    );
  } finally {
    await f.close();
  }
});

test("independent devices generate different offline receipt numbers for the same branch and sequence", async () => {
  const first = await fixture("device-a");
  const second = await fixture("device-b");
  try {
    const a = await first.order();
    const b = await second.order();
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.number, b.number);
    assert.match(a.number, /-DEVICEA-0001$/);
    assert.match(b.number, /-DEVICEB-0001$/);
  } finally {
    await first.close();
    await second.close();
  }
});
