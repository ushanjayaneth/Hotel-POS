import ProductPhoto from '../components/ProductPhoto';
import {deviceDraftId} from '../lib/workspace-mode';
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Clock3,
  Coffee,
  CookingPot,
  CupSoda,
  Flame,
  Grid2X2,
  IceCreamBowl,
  Leaf,
  Minus,
  NotebookPen,
  Plus,
  Printer,
  Search,
  ShoppingBag,
  SlidersHorizontal,
  Trash2,
  Truck,
  UtensilsCrossed,
  Wallet,
  X,
  CheckCircle2,
  Send,
  ShieldCheck,
  PauseCircle,
  Tag,
  Users,
} from "lucide-react";
import type { CartLine, MenuItem, Order } from "../../shared/types";
import { usePOS } from "../lib/context";
import { browserDb } from "../lib/db";
import { commandId, money, time } from "../lib/format";
import { Modal, StatusBadge } from "../components/ui";
import { useBackLayer } from "../lib/navigation";
import { useDevicePreferences, type ShortcutAction } from "../lib/preferences";
import { CategoryDialog, ProductDialog } from "./Products";

const categoryIcons: Record<string, typeof Grid2X2> = {
  rice: CookingPot,
  kottu: Flame,
  noodles: UtensilsCrossed,
  "short-eats": Leaf,
  beverages: CupSoda,
  desserts: IceCreamBowl,
};
export default function POS({
  selectedOrderId,
  onSelectOrder,
  onReceipt,
}: {
  selectedOrderId: string | null;
  onSelectOrder: (id: string | null) => void;
  onReceipt: (id: string) => void;
}) {
  const { data, branchId, mutate, notify, navigate } = usePOS();
  const preferences = useDevicePreferences();
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("featured");
  const [lines, setLines] = useState<CartLine[]>([]);
  const [type, setType] = useState<Order["type"]>("dine-in");
  const [tableId, setTableId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [note, setNote] = useState("");
  const [discount, setDiscount] = useState(0);
  const [orderCommand, setOrderCommand] = useState(commandId);
  const [loadedBranch, setLoadedBranch] = useState("");
  const [draftSaveError,setDraftSaveError]=useState('');
  const [busy, setBusy] = useState(false);
  const [paymentOrder, setPaymentOrder] = useState<string | null>(null);
  const [noteDialog, setNoteDialog] = useState(false);
  const [discountDialog, setDiscountDialog] = useState(false);
  const [mobileCart, setMobileCart] = useState(false);
  const [heldBillId, setHeldBillId] = useState("");
  const [heldBillUpdatedAt, setHeldBillUpdatedAt] = useState("");
  const [holdDialog, setHoldDialog] = useState(false);
  const [holdLabel, setHoldLabel] = useState("");
  const [holdCommand, setHoldCommand] = useState(commandId);
  const [categoryDialog, setCategoryDialog] = useState(false);
  const [productDialog, setProductDialog] = useState(false);
  const [newOrderDialog, setNewOrderDialog] = useState(false);
  const [itemNote, setItemNote] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const scanRef = useRef({ text: "", start: 0, last: 0 });
  useBackLayer(mobileCart, () => setMobileCart(false), "order-drawer");
  useBackLayer(!!search, () => setSearch(""), "menu-search");
  useBackLayer(category !== "all", () => setCategory("all"), "menu-category");
  const order = data.orders.find((o) => o.id === selectedOrderId);
  const activeOrder =
    order && !["completed", "cancelled"].includes(order.status) ? order : null;
  const canTakePayment = ["owner", "manager", "cashier"].includes(
    data.user.role,
  );
  const canManageCatalog = ["owner", "manager"].includes(data.user.role);
  useEffect(() => {
    let active = true;
    setLoadedBranch("");
    void browserDb.drafts
      .get(deviceDraftId(branchId))
      .then((draft) => {
        if (!active) return;
        setLines(draft?.lines || []);
        setType(draft?.type || "dine-in");
        setTableId(draft?.tableId || "");
        setCustomerId(draft?.customerId || "");
        setHeldBillId(draft?.heldBillId || "");
        setHeldBillUpdatedAt(draft?.heldBillUpdatedAt || "");
        setNote(draft?.note || "");
        setDiscount(draft?.discount || 0);
        setOrderCommand(draft?.commandId || commandId());
        const resumeId = sessionStorage.getItem("dh-resume-held");
        if (resumeId) {
          sessionStorage.removeItem("dh-resume-held");
          const bill = (data.heldBills || []).find(
            (item) =>
              item.id === resumeId &&
              item.branchId === branchId &&
              item.status === "held",
          );
          if (bill) {
            setLines(bill.lines);
            setType(bill.type);
            setTableId(bill.tableId || "");
            setCustomerId(bill.customerId || "");
            setNote(bill.note);
            setDiscount(bill.discount);
            setHeldBillId(bill.id);
            setHeldBillUpdatedAt(bill.updatedAt);
            setOrderCommand(commandId());
          } else
            notify(
              "This held bill is no longer available at this branch.",
              "error",
            );
        }
        const newTable = sessionStorage.getItem("dh-new-table");
        if (newTable) {
          setType("dine-in");
          setTableId(newTable);
          sessionStorage.removeItem("dh-new-table");
        }
        setLoadedBranch(branchId);
      })
      .catch(() => {
        if (active) {
          setLines([]);
          setLoadedBranch('');
          setDraftSaveError('Device draft storage is unavailable. Keep this page open until your order has been saved.');
          notify(
            "Device storage is unavailable. Keep this page open until your order is sent.",
            "error",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [branchId, notify]);
  useEffect(() => {
    if (loadedBranch !== branchId) return;
    void browserDb.drafts
      .put({
        id: deviceDraftId(branchId),
        lines,
        type,
        tableId,
        customerId,
        heldBillId,
        heldBillUpdatedAt,
        note,
        discount,
        commandId: orderCommand,
        updatedAt: new Date().toISOString(),
      })
      .then(()=>setDraftSaveError(''))
      .catch(()=>setDraftSaveError('This draft could not be saved on this device. Keep this page open and free storage before leaving.'));
  }, [
    lines,
    type,
    tableId,
    customerId,
    heldBillId,
    heldBillUpdatedAt,
    note,
    discount,
    orderCommand,
    loadedBranch,
    branchId,
  ]);
  const items = data.menu
    .filter(
      (i) =>
        (category === "all" || i.categoryId === category) &&
        `${i.name} ${i.description}`
          .concat(` ${i.barcode || ""} ${i.sku || ""}`)
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "price-low"
        ? a.price - b.price
        : sort === "price-high"
          ? b.price - a.price
          : sort === "name"
            ? a.name.localeCompare(b.name)
            : 0,
    );
  const cart = lines
    .map((line) => ({
      ...line,
      item: data.menu.find((i) => i.id === line.menuItemId)!,
    }))
    .filter((line) => line.item);
  const quantity = cart.reduce((sum, l) => sum + l.quantity, 0);
  const subtotal =
    activeOrder?.subtotal ??
    cart.reduce((sum, l) => sum + l.quantity * l.item.price, 0);
  const actualDiscount = activeOrder?.discount ?? Math.min(discount, subtotal);
  const serviceCharge =
    activeOrder?.serviceCharge ??
    (type === "dine-in"
      ? Math.round(
          ((subtotal - actualDiscount) * data.settings.serviceChargeRate) / 100,
        )
      : 0);
  const tax =
    activeOrder?.tax ??
    Math.round(
      ((subtotal - actualDiscount + serviceCharge) * data.settings.taxRate) /
        100,
    );
  const total =
    activeOrder?.total ?? subtotal - actualDiscount + serviceCharge + tax;
  const currentShift = data.shifts.find((s) => s.status === "open");
  function add(item: MenuItem) {
    if (busy) return;
    if (!item.available) return;
    if (activeOrder) {
      notify("Start a new order to add more items.", "error");
      return;
    }
    setLines((previous) => {
      const existing = previous.find((l) => l.menuItemId === item.id);
      return existing
        ? previous.map((l) =>
            l.menuItemId === item.id ? { ...l, quantity: l.quantity + 1 } : l,
          )
        : [...previous, { menuItemId: item.id, quantity: 1, note: "" }];
    });
  }
  function adjust(id: string, delta: number) {
    if (busy) return;
    setLines((previous) =>
      previous
        .map((l) =>
          l.menuItemId === id ? { ...l, quantity: l.quantity + delta } : l,
        )
        .filter((l) => l.quantity > 0),
    );
  }
  function resetOrder() {
    onSelectOrder(null);
    setLines([]);
    setNote("");
    setDiscount(0);
    setCustomerId("");
    setTableId("");
    setHeldBillId("");
    setHeldBillUpdatedAt("");
    setOrderCommand(commandId());
  }
  function newOrder() {
    if (busy) return;
    if (lines.length) {
      setNewOrderDialog(true);
      return;
    }
    resetOrder();
  }
  async function submit(pay = false) {
    if (activeOrder) {
      if (pay) setPaymentOrder(activeOrder.id);
      return;
    }
    if (!lines.length) return;
    if (type === "dine-in" && !tableId) {
      notify("Choose a table for this dine-in order.", "error");
      setMobileCart(true);
      return;
    }
    setBusy(true);
    try {
      const result = await mutate<{ ok: boolean; order: Order }>("/orders", {
        commandId: orderCommand,
        branchId,
        type,
        tableId: type === "dine-in" ? tableId : null,
        customerId: customerId || null,
        ...(heldBillId
          ? { heldBillId, expectedHeldUpdatedAt: heldBillUpdatedAt }
          : {}),
        note,
        discount: actualDiscount,
        lines,
      });
      onSelectOrder(result.order.id);
      setLines([]);
      setOrderCommand(commandId());
      setNote("");
      setDiscount(0);
      setHeldBillId("");
      setHeldBillUpdatedAt("");
      notify(`Order ${result.order.number} sent to the kitchen.`);
      if (pay) setPaymentOrder(result.order.id);
    } catch (err) {
      notify((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  async function closeTable() {
    if (!activeOrder) return;
    setBusy(true);
    try {
      await mutate(
        `/orders/${activeOrder.id}/status`,
        {
          commandId: commandId(),
          expectedVersion: activeOrder.version,
          status: "completed",
        },
        "PATCH",
      );
      notify("Table closed and ready for the next guest.");
      onReceipt(activeOrder.id);
      onSelectOrder(null);
    } catch (err) {
      notify((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  function openHold() {
    if (busy) return;
    if (activeOrder) {
      notify(
        "Only unconfirmed drafts can be held. Confirmed orders remain in Orders.",
        "error",
      );
      return;
    }
    if (!lines.length) {
      notify("Add products before holding a bill.", "error");
      return;
    }
    setHoldLabel(
      data.heldBills.find((bill) => bill.id === heldBillId)?.label ||
        (tableId
          ? `Table ${data.tables.find((table) => table.id === tableId)?.name || tableId}`
          : `Guest ${time(new Date().toISOString())}`),
    );
    setHoldCommand(commandId());
    setHoldDialog(true);
  }
  async function hold() {
    if (!lines.length || busy || !holdLabel.trim()) return;
    setBusy(true);
    try {
      await mutate(
        heldBillId ? `/held-bills/${heldBillId}` : "/held-bills",
        {
          commandId: holdCommand,
          branchId,
          label: holdLabel.trim(),
          type,
          tableId: type === "dine-in" ? tableId || null : null,
          customerId: customerId || null,
          note,
          discount: actualDiscount,
          lines,
          ...(heldBillId ? { expectedUpdatedAt: heldBillUpdatedAt } : {}),
        },
        heldBillId ? "PUT" : "POST",
      );
      setHoldDialog(false);
      setMobileCart(false);
      resetOrder();
      notify(
        "Bill held. No stock has been deducted and no kitchen ticket was created.",
      );
    } catch (err) {
      notify((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const handler = (event: Event) => {
      const action = (event as CustomEvent<ShortcutAction>).detail;
      if (action === "search") {
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (action === "new-bill") newOrder();
      else if (action === "hold-bill") openHold();
      else if (action === "order-drawer") setMobileCart(true);
      else if (action === "checkout" && canTakePayment && !busy)
        void submit(true);
      else if (action === "send-kitchen" && !busy) void submit(false);
      else if (action === "print") {
        if (activeOrder) {
          onReceipt(activeOrder.id);
          setTimeout(() => window.print(), 250);
        } else notify("Open a confirmed order to print its receipt.");
      }
    };
    window.addEventListener("workspace-shortcut", handler);
    return () => window.removeEventListener("workspace-shortcut", handler);
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        document.querySelector('[role="dialog"]')
      )
        return;
      const target = event.target as HTMLElement;
      if (
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
        target.isContentEditable
      )
        return;
      const now = performance.now();
      const scan = scanRef.current;
      if (event.key === "Enter") {
        const barcode = scan.text;
        const fast =
          barcode.length >= 3 &&
          now - scan.last < 140 &&
          (now - scan.start) / barcode.length < 70;
        scan.text = "";
        if (fast) {
          event.preventDefault();
          const product = data.menu.find(
            (item) => item.barcode === barcode || item.sku === barcode,
          );
          if (product) add(product);
          else notify("That barcode is not assigned to a product.", "error");
        }
        return;
      }
      if (event.key.length === 1 && /^[\x20-\x7E]$/.test(event.key)) {
        if (now - scan.last > 100) {
          scan.text = "";
          scan.start = now;
        }
        if (!scan.text) scan.start = now;
        scan.text = (scan.text + event.key).slice(-160);
        scan.last = now;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [data.menu, activeOrder, busy, notify]);
  return (
    <>
      {draftSaveError&&<div className="error-message" role="alert">{draftSaveError}</div>}
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <span className="status-dot" /> THE FLOOR IS YOURS
          </div>
          <h1>
            Point of sale<span className="heading-period">.</span>
          </h1>
          <p className="page-subtitle">
            Good food. Great service. Everything in its place.
          </p>
        </div>
        <div className="pos-heading-meta">
          <span className={`shift-pill ${!currentShift ? "shift-closed" : ""}`}>
            <span className="status-dot" />
            {currentShift ? "Shift open" : "No open shift"}
          </span>
          <button
            className="button button-ghost new-order-button"
            onClick={() => navigate("held-bills")}
          >
            <PauseCircle size={14} /> Held bills
            {!!data.heldBills.length && (
              <span className="held-count">{data.heldBills.length}</span>
            )}
          </button>
          <button
            className="button button-ghost new-order-button"
            onClick={newOrder}
            disabled={busy}
          >
            <Plus size={14} /> New order
          </button>
        </div>
      </div>
      <div className="pos-layout">
        <section className="catalog">
          <div className="catalog-tools">
            <div className="search-input">
              <Search size={16} />
              <input
                ref={searchRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  const query = search.trim();
                  if (!query) return;
                  const product = data.menu.find(
                    (item) =>
                      item.barcode === query ||
                      item.sku?.toLowerCase() === query.toLowerCase(),
                  );
                  if (!product) return;
                  event.preventDefault();
                  add(product);
                  setSearch("");
                }}
                placeholder="Search name, SKU or barcode..."
                aria-label="Search menu"
              />
              <kbd>{preferences.shortcuts.search}</kbd>
              {search && (
                <button onClick={() => setSearch("")} aria-label="Clear search">
                  <X size={13} />
                </button>
              )}
            </div>
            <label className="sort-select">
              <SlidersHorizontal size={14} />
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value)}
                aria-label="Sort menu"
              >
                <option value="featured">Featured</option>
                <option value="price-low">Price: low to high</option>
                <option value="price-high">Price: high to low</option>
                <option value="name">Name</option>
              </select>
            </label>
          </div>
          {canManageCatalog && (
            <div className="pos-catalog-actions">
              <span>Manage this menu</span>
              <button
                className="button button-ghost"
                onClick={() => setCategoryDialog(true)}
              >
                <Tag size={13} /> Add category
              </button>
              <button
                className="button button-ghost"
                onClick={() => setProductDialog(true)}
              >
                <Plus size={13} /> Add product
              </button>
            </div>
          )}
          <div
            className="category-tabs"
            role="tablist"
            aria-label="Menu categories"
          >
            <button
              role="tab"
              aria-selected={category === "all"}
              className={`category-tab ${category === "all" ? "active" : ""}`}
              onClick={() => setCategory("all")}
            >
              <Grid2X2 size={17} />
              <span>All items</span>
              <small>{data.menu.length}</small>
            </button>
            {data.categories.map((c) => {
              const Icon = categoryIcons[c.id] || CookingPot;
              return (
                <button
                  role="tab"
                  aria-selected={category === c.id}
                  key={c.id}
                  className={`category-tab ${category === c.id ? "active" : ""}`}
                  onClick={() => setCategory(c.id)}
                >
                  <Icon size={17} />
                  <span>{c.name}</span>
                  <small>
                    {data.menu.filter((i) => i.categoryId === c.id).length}
                  </small>
                </button>
              );
            })}
          </div>
          <div className="catalog-title">
            <h2>
              {category === "all"
                ? "Our menu"
                : data.categories.find((c) => c.id === category)?.name}
              <span>{items.length} items</span>
            </h2>
            <span className="catalog-hint">
              <Leaf size={12} /> Fresh from our kitchen
            </span>
          </div>
          <div className="menu-grid">
            {items.map((item) => {
              const count =
                cart.find((l) => l.menuItemId === item.id)?.quantity || 0;
              return (
                <article
                  className={`product-card ${!item.available ? "unavailable" : ""} ${count ? "in-cart" : ""}`}
                  key={item.id}
                >
                  <button
                    className="product-main"
                    onClick={() => add(item)}
                    disabled={!item.available}
                    aria-label={`Add ${item.name}`}
                  >
                    <div className="product-image-wrap">
                      <ProductPhoto src={item.image} alt={item.name} loading="lazy" />
                      {item.badge && (
                        <span
                          className={`product-badge ${item.badge.toLowerCase().includes("popular") ? "popular" : ""}`}
                        >
                          {item.badge}
                        </span>
                      )}
                      {!item.available && (
                        <span className="sold-out">Sold out</span>
                      )}
                      {count > 0 && (
                        <span className="product-count">
                          <Check size={10} />
                          {count} added
                        </span>
                      )}
                    </div>
                    <div className="product-info">
                      <h3>{item.name}</h3>
                      <p>{item.description}</p>
                    </div>
                  </button>
                  <div className="product-bottom">
                    <div>
                      <strong>{money(item.price)}</strong>
                      <span>
                        <Clock3 size={10} />
                        {item.preparationMinutes} min
                      </span>
                    </div>
                    <button
                      className="product-add"
                      disabled={!item.available || !!activeOrder}
                      onClick={() => add(item)}
                      aria-label={`Add one ${item.name}`}
                    >
                      <Plus size={17} />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
          {items.length === 0 && (
            <div className="empty-state">
              <Search size={26} />
              <h3>No dishes found</h3>
              <p>Try another name or choose a different category.</p>
              <button
                className="button button-ghost"
                onClick={() => {
                  setSearch("");
                  setCategory("all");
                }}
              >
                Reset filters
              </button>
            </div>
          )}
          <div className="catalog-bottom">
            <ShieldCheck size={12} />
            <span>Orders are saved securely at your branch.</span>
          </div>
        </section>
        <aside className={`order-panel panel ${mobileCart ? "cart-open" : ""}`}>
          <div className="order-panel-header">
            <div>
              <div className="eyebrow">CURRENT ORDER</div>
              <h2>
                {activeOrder ? activeOrder.number : "New order"}{" "}
                <span>
                  {activeOrder ? (
                    <StatusBadge status={activeOrder.paymentStatus} />
                  ) : (
                    <span className="draft-label">Draft</span>
                  )}
                </span>
              </h2>
            </div>
            <div className="order-header-actions">
              {activeOrder ? (
                <button
                  className="icon-button"
                  onClick={() => onReceipt(activeOrder.id)}
                  title="View receipt"
                  aria-label="View receipt"
                >
                  <Printer size={16} />
                </button>
              ) : (
                <button
                  className="icon-button"
                  onClick={() => {
                    setNewOrderDialog(true);
                  }}
                  disabled={!lines.length || busy}
                  title="Clear order"
                  aria-label="Clear order"
                >
                  <Trash2 size={15} />
                </button>
              )}
              <button
                className="icon-button close-cart"
                onClick={() => setMobileCart(false)}
                aria-label="Close order"
              >
                <X size={18} />
              </button>
            </div>
          </div>
          <div className="order-types">
            {(
              [
                { id: "dine-in", label: "Dine in", icon: UtensilsCrossed },
                { id: "takeaway", label: "Takeaway", icon: ShoppingBag },
                { id: "delivery", label: "Delivery", icon: Truck },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                disabled={!!activeOrder}
                className={
                  (activeOrder?.type || type) === item.id ? "active" : ""
                }
                onClick={() => setType(item.id)}
              >
                <item.icon size={13} />
                {item.label}
              </button>
            ))}
          </div>
          <div className="order-customer-row">
            {(activeOrder?.type || type) === "dine-in" ? (
              <label className="order-table-select">
                <UtensilsCrossed size={13} />
                <select
                  value={activeOrder?.tableId || tableId}
                  disabled={!!activeOrder}
                  onChange={(e) => setTableId(e.target.value)}
                  aria-label="Select table"
                >
                  <option value="">Select a table</option>
                  {data.tables
                    .filter(
                      (t) =>
                        t.status === "available" ||
                        t.id === (activeOrder?.tableId || tableId),
                    )
                    .map((t) => (
                      <option value={t.id} key={t.id}>
                        {t.name} · {t.seats} seats
                      </option>
                    ))}
                </select>
              </label>
            ) : (
              <span className="guest-label">
                <ShoppingBag size={13} />
                {type === "takeaway" ? "Walk-in guest" : "Delivery order"}
              </span>
            )}
            <select
              className="customer-select"
              value={activeOrder?.customerId || customerId}
              disabled={!!activeOrder}
              onChange={(e) => setCustomerId(e.target.value)}
              aria-label="Select customer"
            >
              <option value="">Walk-in guest</option>
              {data.customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="order-items-heading">
            <span>ITEM</span>
            <span>AMOUNT</span>
          </div>
          <div className="cart-lines">
            {activeOrder
              ? activeOrder.lines.map((line) => {
                  const item = data.menu.find((i) => i.id === line.menuItemId);
                  return (
                    <div className="cart-line" key={line.id}>
                      <img src={item?.image} alt="" />
                      <div className="cart-line-info">
                        <h4>{line.name}</h4>
                        <span>
                          {money(line.unitPrice)} <i>× {line.quantity}</i>
                        </span>
                        {line.note && <p>{line.note}</p>}
                      </div>
                      <strong>{money(line.lineTotal)}</strong>
                    </div>
                  );
                })
              : cart.map((line) => (
                  <div className="cart-line" key={line.menuItemId}>
                    <img src={line.item.image} alt="" />
                    <div className="cart-line-info">
                      <h4>{line.item.name}</h4>
                      <span>{money(line.item.price)}</span>
                      <div className="quantity-control">
                        <button
                          onClick={() => adjust(line.menuItemId, -1)}
                          aria-label={`Remove one ${line.item.name}`}
                        >
                          <Minus size={10} />
                        </button>
                        <span>{line.quantity}</span>
                        <button
                          onClick={() => adjust(line.menuItemId, 1)}
                          aria-label={`Add one more ${line.item.name}`}
                        >
                          <Plus size={10} />
                        </button>
                        <button
                          className={`line-note-button ${line.note ? "has-note" : ""}`}
                          onClick={() => {
                            setItemNote(line.menuItemId);
                            setDraftNote(line.note);
                          }}
                          aria-label={`Add note to ${line.item.name}`}
                        >
                          <NotebookPen size={11} />
                        </button>
                      </div>
                      {line.note && <p>{line.note}</p>}
                    </div>
                    <div className="cart-line-end">
                      <strong>{money(line.item.price * line.quantity)}</strong>
                      <button
                        onClick={() =>
                          setLines((v) =>
                            v.filter((l) => l.menuItemId !== line.menuItemId),
                          )
                        }
                        aria-label={`Remove ${line.item.name}`}
                      >
                        <X size={11} />
                      </button>
                    </div>
                  </div>
                ))}
            {!activeOrder && !cart.length && (
              <div className="empty-cart">
                <div className="empty-cart-art">
                  <ShoppingBag size={28} strokeWidth={1.2} />
                  <Plus size={13} className="cart-art-plus" />
                </div>
                <h3>A fresh start.</h3>
                <p>
                  Add something delicious from
                  <br />
                  the menu to begin an order.
                </p>
                <div className="empty-cart-line" />
              </div>
            )}
          </div>
          <div className="cart-footer">
            <div className="cart-options">
              <button
                onClick={() => setNoteDialog(true)}
                disabled={!!activeOrder}
              >
                <NotebookPen size={12} />
                {activeOrder?.note || note ? "View note" : "Add a note"}
                {note && <i />}
              </button>
              <button
                onClick={() => setDiscountDialog(true)}
                disabled={
                  !!activeOrder ||
                  !["owner", "manager"].includes(data.user.role)
                }
              >
                <span className="discount-symbol">%</span>
                {actualDiscount ? "Edit discount" : "Add discount"}
              </button>
            </div>
            {!activeOrder && lines.length > 0 && (
              <button
                className="button hold-bill-button"
                onClick={openHold}
                disabled={busy || !data.sync.hubOnline}
              >
                <PauseCircle size={14} />
                {heldBillId ? "Update held bill" : "Hold bill"}
                <span>Save for later</span>
              </button>
            )}
            {activeOrder && (
              <div className="order-saved-label">
                <CheckCircle2 size={12} /> Saved at branch ·{" "}
                {time(activeOrder.createdAt)}
                <StatusBadge status={activeOrder.status} />
              </div>
            )}
            <div className="order-totals">
              <div>
                <span>Subtotal</span>
                <span>{money(subtotal)}</span>
              </div>
              {actualDiscount > 0 && (
                <div className="text-mint">
                  <span>Discount</span>
                  <span>− {money(actualDiscount)}</span>
                </div>
              )}
              <div>
                <span>
                  Service charge{" "}
                  <small>({data.settings.serviceChargeRate}%)</small>
                </span>
                <span>{money(serviceCharge)}</span>
              </div>
              <div>
                <span>
                  Tax <small>({data.settings.taxRate}%)</small>
                </span>
                <span>{money(tax)}</span>
              </div>
              {activeOrder && activeOrder.paid > 0 && (
                <div className="text-mint">
                  <span>Already paid</span>
                  <span>− {money(activeOrder.paid)}</span>
                </div>
              )}
            </div>
            <div className="order-total">
              <span>
                {activeOrder?.paid ? "Balance due" : "Total"}
                <small>
                  {activeOrder
                    ? activeOrder.lines.reduce((s, l) => s + l.quantity, 0)
                    : quantity}{" "}
                  items
                </small>
              </span>
              <strong>
                {money(Math.max(0, total - (activeOrder?.paid || 0)))}
              </strong>
            </div>
            {activeOrder?.paymentStatus === "paid" ? (
              <button
                className="button button-primary checkout-button"
                onClick={
                  activeOrder.type === "dine-in" &&
                  ["ready", "served"].includes(activeOrder.status)
                    ? () => void closeTable()
                    : () => onReceipt(activeOrder.id)
                }
                disabled={busy}
              >
                <CheckCircle2 size={16} />
                {activeOrder.type === "dine-in" &&
                ["ready", "served"].includes(activeOrder.status)
                  ? "Close table & print"
                  : "View receipt"}
                <ArrowRight size={16} />
              </button>
            ) : (
              <>
                <button
                  className="button button-primary checkout-button"
                  disabled={
                    busy ||
                    !data.sync.hubOnline ||
                    (!activeOrder && !lines.length) ||
                    !canTakePayment
                  }
                  onClick={() => void submit(true)}
                >
                  <Wallet size={16} />
                  {busy
                    ? "Saving order..."
                    : activeOrder
                      ? "Take payment"
                      : "Charge order"}
                  <ArrowRight size={16} />
                </button>
                {!activeOrder && (
                  <button
                    className="button send-kitchen-button"
                    disabled={busy || !lines.length || !data.sync.hubOnline}
                    onClick={() => void submit(false)}
                  >
                    <Send size={13} /> Send to kitchen
                  </button>
                )}
              </>
            )}
            <div className="cart-safety">
              <ShieldCheck size={10} />
              {activeOrder
                ? "Order confirmed by your branch"
                : "Draft is saved on this device"}
            </div>
          </div>
        </aside>
      </div>
      <button
        className="mobile-cart-button"
        onClick={() => setMobileCart(true)}
      >
        <ShoppingBag size={18} />
        <span>
          View order{" "}
          <small>
            {activeOrder ? activeOrder.lines.length : quantity} items
          </small>
        </span>
        <strong>{money(total)}</strong>
        <ArrowRight size={17} />
      </button>
      {paymentOrder && (
        <PaymentDialog
          orderId={paymentOrder}
          onClose={() => setPaymentOrder(null)}
          onPaid={(id) => {
            setPaymentOrder(null);
            setMobileCart(false);
            onReceipt(id);
            const paidOrder = data.orders.find((o) => o.id === id);
            if (paidOrder?.type !== "dine-in") onSelectOrder(null);
          }}
        />
      )}
      {categoryDialog && (
        <CategoryDialog
          onClose={() => setCategoryDialog(false)}
          onCreated={(id) => setCategory(id)}
        />
      )}
      {productDialog && (
        <ProductDialog
          onClose={() => setProductDialog(false)}
          categoryId={category === "all" ? undefined : category}
        />
      )}
      {newOrderDialog && (
        <Modal
          title="Start a new order?"
          subtitle="Your current draft contains items. Hold it to continue serving this guest later."
          onClose={() => setNewOrderDialog(false)}
        >
          <div className="draft-confirm-summary">
            <ShoppingBag size={20} />
            <span>{quantity} items in your current draft</span>
            <strong>
              {money(
                cart.reduce(
                  (sum, line) => sum + line.quantity * line.item.price,
                  0,
                ),
              )}
            </strong>
          </div>
          <div className="form-actions draft-confirm-actions">
            <button
              className="button button-ghost"
              onClick={() => setNewOrderDialog(false)}
            >
              Keep editing
            </button>
            <button
              className="button button-ghost"
              onClick={() => {
                setNewOrderDialog(false);
                resetOrder();
              }}
            >
              Discard draft
            </button>
            <button
              className="button button-primary"
              disabled={!data.sync.hubOnline}
              onClick={() => {
                setNewOrderDialog(false);
                onSelectOrder(null);
                setHoldLabel(
                  data.heldBills.find((bill) => bill.id === heldBillId)
                    ?.label || "Guest order",
                );
                setHoldCommand(commandId());
                setHoldDialog(true);
              }}
            >
              <PauseCircle size={14} /> Hold & start new
            </button>
          </div>
        </Modal>
      )}
      {holdDialog && (
        <Modal
          title={heldBillId ? "Update held bill" : "Hold bill"}
          subtitle="Save this draft at the branch without creating a sale or deducting stock."
          onClose={() => !busy && setHoldDialog(false)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void hold();
            }}
          >
            <label className="field">
              <span>Bill label</span>
              <input
                className="input"
                value={holdLabel}
                onChange={(event) => setHoldLabel(event.target.value)}
                required
                maxLength={120}
                placeholder="Guest name, table or reference"
                autoFocus
              />
            </label>
            <p className="held-bill-note">
              Resume this bill from Held bills on any connected device at this
              branch.
            </p>
            <div className="form-actions">
              <button
                type="button"
                className="button button-ghost"
                disabled={busy}
                onClick={() => setHoldDialog(false)}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                disabled={busy || !holdLabel.trim()}
              >
                <PauseCircle size={14} />{" "}
                {busy
                  ? "Saving..."
                  : heldBillId
                    ? "Update held bill"
                    : "Hold bill"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {noteDialog && (
        <Modal
          title="Order note"
          subtitle="Add preparation, allergy, or service instructions."
          onClose={() => setNoteDialog(false)}
        >
          <textarea
            className="input"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            placeholder="For example: guest has a nut allergy"
            aria-label="Order note"
          />
          <div className="form-actions">
            <button
              className="button button-primary"
              onClick={() => setNoteDialog(false)}
            >
              Save note
            </button>
          </div>
        </Modal>
      )}
      {itemNote && (
        <Modal title="Item instructions" onClose={() => setItemNote(null)}>
          <textarea
            className="input"
            value={draftNote}
            maxLength={300}
            onChange={(e) => setDraftNote(e.target.value)}
            placeholder="Less spice, no onions..."
            aria-label="Item instructions"
          />
          <div className="form-actions">
            <button
              className="button button-primary"
              onClick={() => {
                setLines((v) =>
                  v.map((l) =>
                    l.menuItemId === itemNote ? { ...l, note: draftNote } : l,
                  ),
                );
                setItemNote(null);
              }}
            >
              Save instructions
            </button>
          </div>
        </Modal>
      )}
      {discountDialog && (
        <DiscountDialog
          subtotal={subtotal}
          discount={discount}
          onClose={() => setDiscountDialog(false)}
          onSave={(value) => {
            setDiscount(value);
            setDiscountDialog(false);
          }}
        />
      )}
    </>
  );
}

function DiscountDialog({
  subtotal,
  discount,
  onClose,
  onSave,
}: {
  subtotal: number;
  discount: number;
  onClose: () => void;
  onSave: (value: number) => void;
}) {
  const [value, setValue] = useState((discount / 100).toString());
  return (
    <Modal
      title="Order discount"
      subtitle="Discounts are recorded against your staff account."
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(Math.round(Number(value) * 100));
        }}
      >
        <label className="field">
          <span>Discount amount (LKR)</span>
          <input
            className="input"
            type="number"
            required
            min="0"
            max={subtotal / 100}
            step="0.01"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <div className="form-actions">
          <button
            type="button"
            className="button button-ghost"
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="button button-primary">Apply discount</button>
        </div>
      </form>
    </Modal>
  );
}

export function PaymentDialog({
  orderId,
  onClose,
  onPaid,
}: {
  orderId: string;
  onClose: () => void;
  onPaid: (id: string) => void;
}) {
  const { data, mutate, notify } = usePOS();
  const order = data.orders.find((o) => o.id === orderId);
  const [method, setMethod] = useState<"cash" | "card" | "qr" | "credit">(
    "cash",
  );
  const due = order ? Math.max(0, order.total - order.paid) : 0;
  const [amount, setAmount] = useState((due / 100).toString());
  const [received, setReceived] = useState((due / 100).toString());
  const [reference, setReference] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [id] = useState(commandId);
  if (!order) return null;
  const customer = data.customers.find((item) => item.id === order.customerId);
  const minor = Math.round(Number(amount) * 100);
  const receivedMinor = Math.round(Number(received) * 100);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!order || busy) return;
    if (method === "credit" && !customer) {
      setError(
        "Select a customer before confirming an order for customer credit.",
      );
      return;
    }
    setError("");
    setBusy(true);
    try {
      await mutate(`/orders/${order.id}/payments`, {
        commandId: id,
        expectedVersion: order.version,
        method,
        amount: minor,
        received: method === "cash" ? receivedMinor : minor,
        reference: method === "credit" ? "" : reference,
      });
      notify(
        method === "credit"
          ? `Credit recorded for ${customer?.name}. Collect it from Customers & dues.`
          : minor < due
            ? "Partial payment recorded."
            : "Payment recorded. Thank you!",
      );
      onPaid(order.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Take payment"
      subtitle={`${order.number} · ${order.type.replace("-", " ")}`}
      onClose={() => !busy && onClose()}
    >
      <form onSubmit={(e) => void submit(e)}>
        <div className="payment-due">
          <span>Balance due</span>
          <strong>{money(due)}</strong>
          <small>Order total {money(order.total)}</small>
        </div>
        <div className="payment-methods">
          {(
            [
              { id: "cash", name: "Cash", icon: Wallet },
              { id: "card", name: "Card", icon: Wallet },
              { id: "qr", name: "QR / Bank", icon: Grid2X2 },
              { id: "credit", name: "Customer credit", icon: Users },
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              type="button"
              className={method === m.id ? "active" : ""}
              onClick={() => {
                setMethod(m.id);
                setConfirmed(false);
              }}
              disabled={busy || (m.id === "credit" && !customer)}
              title={
                m.id === "credit" && !customer
                  ? "Select a customer before sending this order to use customer credit."
                  : undefined
              }
            >
              <m.icon size={20} />
              {m.name}
            </button>
          ))}
        </div>
        {!customer && (
          <p className="held-bill-note">
            To offer customer credit, select a customer before sending the
            order.
          </p>
        )}
        {error && (
          <div className="error-message" role="alert">
            {error}
          </div>
        )}
        <div className="form-grid">
          <label className="field">
            <span>Payment amount (LKR)</span>
            <input
              className="input"
              type="number"
              min="0.01"
              max={due / 100}
              step="0.01"
              required
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setReceived(e.target.value);
              }}
            />
          </label>
          {method === "cash" ? (
            <label className="field">
              <span>Cash received (LKR)</span>
              <input
                className="input"
                type="number"
                required
                min={Number(amount)}
                step="0.01"
                value={received}
                onChange={(e) => setReceived(e.target.value)}
              />
            </label>
          ) : method === "credit" ? (
            <div className="credit-customer-summary">
              <Users size={19} />
              <div>
                <span>Charge to customer account</span>
                <strong>{customer?.name}</strong>
                <small>{customer?.phone}</small>
              </div>
            </div>
          ) : (
            <label className="field">
              <span>Terminal / bank reference</span>
              <input
                className="input"
                required
                maxLength={120}
                placeholder="Approved transaction reference"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </label>
          )}
        </div>
        {method === "cash" ? (
          <>
            <div className="cash-shortcuts">
              {[1000, 2000, 5000]
                .filter((v) => v >= Number(amount))
                .map((v) => (
                  <button
                    type="button"
                    key={v}
                    onClick={() => setReceived(v.toString())}
                  >
                    Rs. {v.toLocaleString()}
                  </button>
                ))}
              <button type="button" onClick={() => setReceived(amount)}>
                Exact amount
              </button>
            </div>
            <div className="change-due">
              <span>Change to guest</span>
              <strong>{money(Math.max(0, receivedMinor - minor))}</strong>
            </div>
          </>
        ) : (
          <label className="payment-confirmation">
            <input
              type="checkbox"
              checked={confirmed}
              required
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>
              {method === "credit"
                ? `I confirm ${customer?.name} is authorised for this credit sale. The amount will be added to their outstanding dues.`
                : "I have verified the approved payment on the terminal or bank account. This action records the payment; it does not charge a card."}
            </span>
          </label>
        )}
        <div className="form-actions">
          <button
            type="button"
            className="button button-ghost"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="button button-primary"
            disabled={
              busy ||
              minor <= 0 ||
              minor > due ||
              (method === "cash" && receivedMinor < minor) ||
              (method === "credit" && !customer) ||
              (method !== "cash" && !confirmed)
            }
          >
            <CheckCircle2 size={15} />
            {busy
              ? "Recording..."
              : method === "credit"
                ? "Confirm credit sale"
                : "Confirm payment"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
