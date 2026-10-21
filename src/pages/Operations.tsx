import { useEffect, useState, type CSSProperties } from "react";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChefHat,
  ChevronRight,
  Clock3,
  Download,
  FileText,
  Flame,
  History,
  LayoutGrid,
  MoreHorizontal,
  Plus,
  Printer,
  Search,
  ShieldCheck,
  ShoppingBag,
  Truck,
  Users,
  UtensilsCrossed,
  Wallet,
  XCircle,
} from "lucide-react";
import type { Branch, Order, OrderStatus, Settings } from "../../shared/types";
import { usePOS } from "../lib/context";
import { commandId, dateTime, elapsed, money, time } from "../lib/format";
import { EmptyState, Modal, StatusBadge } from "../components/ui";
import { PaymentDialog } from "./POS";
import { receiptDimensions, receiptPrintCss } from "../lib/receipt";
import { useDevicePreferences } from "../lib/preferences";

const typeIcons = {
  "dine-in": UtensilsCrossed,
  takeaway: ShoppingBag,
  delivery: Truck,
};
export function Orders({
  onOpen,
  onReceipt,
  historyView = false,
}: {
  onOpen: (id: string) => void;
  onReceipt: (id: string) => void;
  historyView?: boolean;
}) {
  const { data, mutate, notify } = usePOS();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState(historyView ? "all" : "active");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [refundOrder, setRefundOrder] = useState<Order | null>(null);
  const [cancelOrder, setCancelOrder] = useState<Order | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"cards" | "list">(
    historyView ? "list" : "cards",
  );
  const active = data.orders.filter(
    (o) => !["completed", "cancelled"].includes(o.status),
  );
  const source = historyView
    ? data.orders.filter(
        (o) => o.paid > 0 || ["completed", "cancelled"].includes(o.status),
      )
    : data.orders;
  const orders = source.filter(
    (o) =>
      (filter === "all" ||
        (filter === "active"
          ? !["completed", "cancelled"].includes(o.status)
          : filter === "unpaid"
            ? o.paymentStatus !== "paid" && o.status !== "cancelled"
            : filter === "paid"
              ? o.paymentStatus === "paid"
              : filter === "refunded"
                ? o.refunded > 0
                : o.status === filter)) &&
      (!fromDate ||
        new Date(o.createdAt).getTime() >=
          new Date(`${fromDate}T00:00:00`).getTime()) &&
      (!toDate ||
        new Date(o.createdAt).getTime() <
          new Date(`${toDate}T23:59:59.999`).getTime() + 1) &&
      `${o.number} ${o.lines.map((l) => l.name).join(" ")} ${data.tables.find((t) => t.id === o.tableId)?.name || ""} ${data.customers.find((c) => c.id === o.customerId)?.name || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const canPay = ["owner", "manager", "cashier"].includes(data.user.role);
  const canRefund = ["owner", "manager"].includes(data.user.role);
  function exportOrders() {
    const rows = [
      [
        "Order",
        "Created",
        "Type",
        "Status",
        "Payment",
        "Total LKR",
        "Paid LKR",
      ],
      ...orders.map((o) => [
        o.number,
        o.createdAt,
        o.type,
        o.status,
        o.paymentStatus,
        (o.total / 100).toFixed(2),
        (o.paid / 100).toFixed(2),
      ]),
    ];
    const csv = rows
      .map((row) =>
        row
          .map((value) => `"${String(value).replaceAll('"', '""')}"`)
          .join(","),
      )
      .join("\r\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${historyView ? "sales-history" : "orders"}-${data.branch.code}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    notify(historyView ? "Sales history exported." : "Orders exported.");
  }
  async function cancel(reason: string) {
    if (!cancelOrder) return;
    setBusy(true);
    try {
      await mutate(
        `/orders/${cancelOrder.id}/status`,
        {
          commandId: commandId(),
          expectedVersion: cancelOrder.version,
          status: "cancelled",
          reason,
        },
        "PATCH",
      );
      notify(
        "Order cancelled. Stock disposition is recorded in the audit trail.",
      );
      setCancelOrder(null);
    } catch (err) {
      notify((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {historyView ? "YOUR SERVICE RECORD" : "SERVICE, AT A GLANCE"}
          </div>
          <h1>
            {historyView ? "Sales history" : "Orders"}
            <span className="heading-period">.</span>
          </h1>
          <p className="page-subtitle">
            {historyView
              ? "Review payments, completed and cancelled bills. Reprint any receipt."
              : "From the first ticket to the final receipt."}
          </p>
        </div>
        <button className="button" onClick={exportOrders}>
          <Download size={14} /> Export
        </button>
      </div>
      <div className="operation-summary">
        <div className="panel operation-stat">
          <span>{historyView ? "Matching bills" : "Open orders"}</span>
          <strong>
            {(historyView ? orders.length : active.length)
              .toString()
              .padStart(2, "0")}
          </strong>
          <span className="operation-stat-icon">
            <ClipboardIcon />
          </span>
        </div>
        <div className="panel operation-stat">
          <span>{historyView ? "Settled bills" : "In the kitchen"}</span>
          <strong>
            {(historyView ? orders : data.orders)
              .filter((o) =>
                historyView
                  ? o.paymentStatus === "paid"
                  : ["new", "preparing"].includes(o.status),
              )
              .length.toString()
              .padStart(2, "0")}
          </strong>
          <span className="operation-stat-icon">
            <ChefHat size={20} />
          </span>
        </div>
        <div className="panel operation-stat">
          <span>{historyView ? "Cancelled bills" : "Ready to serve"}</span>
          <strong>
            {(historyView ? orders : data.orders)
              .filter((o) => o.status === (historyView ? "cancelled" : "ready"))
              .length.toString()
              .padStart(2, "0")}
          </strong>
          <span className="operation-stat-icon">
            <CheckCircle2 size={20} />
          </span>
        </div>
        <div className="panel operation-stat">
          <span>
            {historyView ? "Payments less refunds" : "Outstanding balance"}
          </span>
          <strong className="stat-money">
            {money(
              historyView
                ? orders.reduce((sum, o) => sum + o.paid - o.refunded, 0)
                : active.reduce(
                    (sum, o) => sum + Math.max(0, o.total - o.paid),
                    0,
                  ),
            )}
          </strong>
          <span className="operation-stat-icon">
            <Wallet size={20} />
          </span>
        </div>
      </div>
      <div className="operations-toolbar">
        <div className="filter-tabs">
          {(historyView
            ? [
                { id: "all", label: "All history", count: source.length },
                { id: "paid", label: "Settled" },
                { id: "completed", label: "Completed" },
                { id: "refunded", label: "Refunded" },
                { id: "cancelled", label: "Cancelled" },
              ]
            : [
                { id: "active", label: "Open", count: active.length },
                { id: "all", label: "All orders" },
                { id: "unpaid", label: "Unpaid" },
                { id: "completed", label: "Completed" },
                { id: "cancelled", label: "Cancelled" },
              ]
          ).map((f) => (
            <button
              key={f.id}
              className={filter === f.id ? "active" : ""}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              {f.count !== undefined && <small>{f.count}</small>}
            </button>
          ))}
        </div>
        <div className="operations-tool-right">
          <div className="search-input compact">
            <Search size={14} />
            <input
              placeholder="Search orders..."
              aria-label="Search orders"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button
            className="icon-button"
            onClick={() => setView(view === "cards" ? "list" : "cards")}
            aria-label="Toggle order view"
          >
            {view === "cards" ? (
              <FileText size={15} />
            ) : (
              <LayoutGrid size={15} />
            )}
          </button>
        </div>
      </div>
      {historyView && (
        <div
          className="operations-toolbar"
          style={{ justifyContent: "flex-start", gap: 12, flexWrap: "wrap" }}
        >
          <label className="field" style={{ minWidth: 150, flex: "0 1 190px" }}>
            <span>From date</span>
            <input
              className="input"
              aria-label="Sales history from date"
              type="date"
              value={fromDate}
              max={toDate || undefined}
              onChange={(event) => setFromDate(event.target.value)}
            />
          </label>
          <label className="field" style={{ minWidth: 150, flex: "0 1 190px" }}>
            <span>To date</span>
            <input
              className="input"
              aria-label="Sales history to date"
              type="date"
              value={toDate}
              min={fromDate || undefined}
              onChange={(event) => setToDate(event.target.value)}
            />
          </label>
          {(fromDate || toDate) && (
            <button
              className="button button-ghost button-small"
              onClick={() => {
                setFromDate("");
                setToDate("");
              }}
            >
              Clear dates
            </button>
          )}
        </div>
      )}
      {orders.length === 0 ? (
        <div className="panel">
          <EmptyState
            title={
              historyView
                ? "No bills match these filters"
                : "Nothing on this ticket rail"
            }
            description={
              historyView
                ? "Try another date range or search. Bills with payments, completed bills and cancellations appear here."
                : "New orders will appear here. Try another filter to see past service."
            }
          />
        </div>
      ) : view === "list" ? (
        <div className="panel table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Service</th>
                <th>Created</th>
                <th>Status</th>
                <th>Payment</th>
                <th className="text-right">Total</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>
                    <strong>{o.number}</strong>
                  </td>
                  <td>
                    {o.type === "dine-in"
                      ? data.tables.find((t) => t.id === o.tableId)?.name
                      : o.type}
                  </td>
                  <td>{dateTime(o.createdAt)}</td>
                  <td>
                    <StatusBadge status={o.status} />
                  </td>
                  <td>
                    <StatusBadge status={o.paymentStatus} />
                  </td>
                  <td className="text-right">{money(o.total)}</td>
                  <td>
                    <button
                      className="icon-button"
                      onClick={() => onReceipt(o.id)}
                      title="View receipt"
                    >
                      <ChevronRight size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="orders-grid">
          {orders.map((o) => {
            const Icon = typeIcons[o.type];
            return (
              <article className="panel order-card" key={o.id}>
                <div className="order-card-head">
                  <div className="order-type-icon">
                    <Icon size={17} />
                  </div>
                  <div>
                    <h3>{o.number}</h3>
                    <span>
                      {o.type === "dine-in"
                        ? data.tables.find((t) => t.id === o.tableId)?.name ||
                          "Dine in"
                        : o.type === "takeaway"
                          ? "Takeaway"
                          : "Delivery"}{" "}
                      <i>·</i> {time(o.createdAt)}
                    </span>
                  </div>
                  <StatusBadge status={o.status} />
                </div>
                <div className="order-card-items">
                  {o.lines.slice(0, 3).map((l) => (
                    <div key={l.id}>
                      <span className="order-line-qty">{l.quantity}×</span>
                      <span>
                        {l.name}
                        {(l.discount || 0) > 0 && (
                          <small style={{ display: "block" }}>
                            Item discount − {money(l.discount || 0)}
                          </small>
                        )}
                      </span>
                      <span>{money(l.lineTotal)}</span>
                    </div>
                  ))}
                  {o.lines.length > 3 && (
                    <small>+ {o.lines.length - 3} more items</small>
                  )}
                </div>
                <div className="order-card-total">
                  <span>
                    {o.lines.reduce((s, l) => s + l.quantity, 0)} items <i>·</i>{" "}
                    <StatusBadge status={o.paymentStatus} />
                  </span>
                  <strong>{money(o.total)}</strong>
                </div>
                <div className="order-card-actions">
                  {!["completed", "cancelled"].includes(o.status) && (
                    <button
                      className="button button-ghost button-small"
                      onClick={() => onOpen(o.id)}
                    >
                      Open order <ArrowRight size={12} />
                    </button>
                  )}
                  {canPay &&
                    o.paymentStatus !== "paid" &&
                    o.status !== "cancelled" && (
                      <button
                        className="button button-primary button-small"
                        onClick={() => setPaymentId(o.id)}
                      >
                        Take payment
                      </button>
                    )}
                  <button
                    className="icon-button"
                    onClick={() => onReceipt(o.id)}
                    aria-label={`Receipt for ${o.number}`}
                  >
                    <Printer size={14} />
                  </button>
                  {canRefund && o.paid - o.refunded > 0 && (
                    <button
                      className="button button-ghost button-small"
                      onClick={() => setRefundOrder(o)}
                    >
                      Refund
                    </button>
                  )}
                  {canRefund &&
                    o.paid === 0 &&
                    !["cancelled", "completed"].includes(o.status) && (
                      <button
                        className="icon-button"
                        onClick={() => setCancelOrder(o)}
                        aria-label={`Cancel ${o.number}`}
                      >
                        <XCircle size={14} />
                      </button>
                    )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      {paymentId && (
        <PaymentDialog
          orderId={paymentId}
          onClose={() => setPaymentId(null)}
          onPaid={(id) => {
            setPaymentId(null);
            onReceipt(id);
          }}
        />
      )}
      {refundOrder && (
        <RefundDialog
          order={refundOrder}
          onClose={() => setRefundOrder(null)}
        />
      )}{" "}
      {cancelOrder && (
        <ReasonDialog
          title={`Cancel ${cancelOrder.number}`}
          description="Prepared food is not automatically returned to sellable stock. Record the reason for the audit trail."
          busy={busy}
          onClose={() => setCancelOrder(null)}
          onSubmit={(reason) => void cancel(reason)}
        />
      )}
    </>
  );
}
function ClipboardIcon() {
  return <FileText size={20} />;
}
function ReasonDialog({
  title,
  description,
  busy,
  onClose,
  onSubmit,
}: {
  title: string;
  description: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Modal title={title} subtitle={description} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(reason);
        }}
      >
        <label className="field">
          <span>Reason</span>
          <textarea
            required
            minLength={3}
            maxLength={300}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <div className="form-actions">
          <button
            type="button"
            className="button button-ghost"
            onClick={onClose}
          >
            Keep order
          </button>
          <button className="button button-danger" disabled={busy}>
            {busy ? "Saving..." : "Confirm cancellation"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function RefundDialog({
  order,
  onClose,
}: {
  order: Order;
  onClose: () => void;
}) {
  const { mutate, notify } = usePOS();
  const [amount, setAmount] = useState(
    ((order.paid - order.refunded) / 100).toString(),
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [id] = useState(commandId);
  return (
    <Modal
      title="Record a refund"
      subtitle={`${order.number} · available ${money(order.paid - order.refunded)}`}
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await mutate(`/orders/${order.id}/refunds`, {
              commandId: id,
              expectedVersion: order.version,
              amount: Math.round(Number(amount) * 100),
              reason,
            });
            notify(
              "Refund recorded. Check the original payment channel for settlement.",
            );
            onClose();
          } catch (err) {
            notify((err as Error).message, "error");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="notice-banner">
          <ShieldCheck size={16} /> Prepared food is not returned to sellable
          stock. Electronic refunds require separate provider settlement.
        </div>
        <div className="form-grid">
          <label className="field full-width">
            <span>Refund amount (LKR)</span>
            <input
              className="input"
              type="number"
              min="0.01"
              max={(order.paid - order.refunded) / 100}
              step="0.01"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label className="field full-width">
            <span>Reason</span>
            <textarea
              required
              minLength={3}
              maxLength={300}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this payment being refunded?"
            />
          </label>
        </div>
        <div className="form-actions">
          <button
            className="button button-ghost"
            type="button"
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="button button-danger" disabled={busy}>
            {busy ? "Recording..." : "Record refund"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function Kitchen() {
  const { data, mutate, notify } = usePOS();
  const [busy, setBusy] = useState<string | null>(null);
  const [type, setType] = useState("all");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const orders = data.orders.filter(
    (o) =>
      ["new", "preparing", "ready"].includes(o.status) &&
      (type === "all" || o.type === type),
  );
  const canUpdate = ["owner", "manager", "kitchen", "waiter"].includes(
    data.user.role,
  );
  async function progress(order: Order, status: OrderStatus) {
    setBusy(order.id);
    try {
      await mutate(
        `/orders/${order.id}/status`,
        { commandId: commandId(), expectedVersion: order.version, status },
        "PATCH",
      );
      notify(
        `${order.number} is ${status === "preparing" ? "being prepared" : status === "ready" ? "ready to serve" : "served"}.`,
      );
    } catch (err) {
      notify((err as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <span className="status-dot" /> LIVE KITCHEN
          </div>
          <h1>
            On the pass<span className="heading-period">.</span>
          </h1>
          <p className="page-subtitle">
            A clear view of what’s cooking, and what’s next.
          </p>
        </div>
        <div className="kitchen-clock">
          <Clock3 size={15} />
          {time(new Date(now).toISOString())}
          <span>Auto-refresh on</span>
        </div>
      </div>
      <div className="operations-toolbar">
        <div className="filter-tabs">
          {[
            { id: "all", name: "All tickets" },
            { id: "dine-in", name: "Dine in" },
            { id: "takeaway", name: "Takeaway" },
            { id: "delivery", name: "Delivery" },
          ].map((t) => (
            <button
              key={t.id}
              className={type === t.id ? "active" : ""}
              onClick={() => setType(t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>
        <span className="muted" style={{ fontSize: 10 }}>
          {orders.length} active tickets
        </span>
      </div>
      <div className="kitchen-board">
        {(
          [
            {
              status: "new",
              label: "New tickets",
              subtitle: "Ready to get started",
              next: "preparing",
              action: "Start preparing",
              icon: FileText,
            },
            {
              status: "preparing",
              label: "Preparing",
              subtitle: "A little care in every dish",
              next: "ready",
              action: "Mark ready",
              icon: Flame,
            },
            {
              status: "ready",
              label: "Ready to serve",
              subtitle: "From the pass to the guest",
              next: "served",
              action: "Mark served",
              icon: CheckCircle2,
            },
          ] as const
        ).map((column) => {
          const tickets = orders.filter((o) => o.status === column.status);
          return (
            <section
              className={`kitchen-column kitchen-${column.status}`}
              key={column.status}
            >
              <div className="kitchen-column-heading">
                <span className="kitchen-column-icon">
                  <column.icon size={16} />
                </span>
                <div>
                  <h2>
                    {column.label}
                    <small>{tickets.length}</small>
                  </h2>
                  <p>{column.subtitle}</p>
                </div>
              </div>
              <div className="kitchen-tickets">
                {tickets.map((o) => {
                  const mins = elapsed(o.createdAt);
                  const Icon = typeIcons[o.type];
                  return (
                    <article
                      className={`panel kitchen-ticket ${mins > 20 ? "ticket-late" : ""}`}
                      key={o.id}
                    >
                      <div className="ticket-top">
                        <div>
                          <h3>{o.number}</h3>
                          <span>
                            <Icon size={12} />
                            {o.type === "dine-in"
                              ? data.tables.find((t) => t.id === o.tableId)
                                  ?.name
                              : o.type}
                          </span>
                        </div>
                        <div
                          className={`ticket-age ${mins > 20 ? "late" : ""}`}
                        >
                          <Clock3 size={12} />
                          {mins}m
                        </div>
                      </div>
                      <div className="ticket-lines">
                        {o.lines.map((l) => (
                          <div className="ticket-line" key={l.id}>
                            <strong>{l.quantity}</strong>
                            <div>
                              <span>{l.name}</span>
                              {l.note && <small>{l.note}</small>}
                            </div>
                            <span className="ticket-line-check" />
                          </div>
                        ))}
                      </div>
                      {o.note && (
                        <div className="ticket-note">
                          <FileText size={12} />
                          {o.note}
                        </div>
                      )}
                      <div className="ticket-bottom">
                        <span>Received {time(o.createdAt)}</span>
                        <span>
                          {o.lines.reduce((s, l) => s + l.quantity, 0)} items
                        </span>
                      </div>
                      <button
                        className={`button kitchen-action ${column.status === "ready" ? "button-primary" : ""}`}
                        disabled={
                          !canUpdate || busy === o.id || !data.sync.hubOnline
                        }
                        onClick={() => void progress(o, column.next)}
                      >
                        <column.icon size={14} />
                        {busy === o.id ? "Updating..." : column.action}
                        <ArrowRight size={14} />
                      </button>
                    </article>
                  );
                })}
                {!tickets.length && (
                  <div className="kitchen-empty">
                    <Check size={22} />
                    <span>
                      {column.status === "new"
                        ? "All caught up."
                        : "No tickets here yet."}
                    </span>
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

export function Tables({
  onOpen,
  onNew,
}: {
  onOpen: (id: string) => void;
  onNew: (tableId: string) => void;
}) {
  const { data } = usePOS();
  const [area, setArea] = useState("all");
  const areas = [...new Set(data.tables.map((t) => t.area))];
  const occupied = data.tables.filter((t) => t.status === "occupied").length;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">A SEAT FOR EVERY GUEST</div>
          <h1>
            The floor<span className="heading-period">.</span>
          </h1>
          <p className="page-subtitle">
            {data.tables.length - occupied} tables available · {occupied} in
            service
          </p>
        </div>
        <div className="table-legend">
          <span>
            <i />
            Available
          </span>
          <span>
            <i />
            Occupied
          </span>
        </div>
      </div>
      <div className="operations-toolbar">
        <div className="filter-tabs">
          <button
            className={area === "all" ? "active" : ""}
            onClick={() => setArea("all")}
          >
            All areas
          </button>
          {areas.map((a) => (
            <button
              key={a}
              className={area === a ? "active" : ""}
              onClick={() => setArea(a)}
            >
              {a}
            </button>
          ))}
        </div>
        <span className="muted" style={{ fontSize: 10 }}>
          <Users
            size={12}
            style={{ verticalAlign: "middle", marginRight: 6 }}
          />
          {data.tables.reduce((s, t) => s + t.seats, 0)} total seats
        </span>
      </div>
      <div className="tables-grid">
        {data.tables
          .filter((t) => area === "all" || t.area === area)
          .map((table) => {
            const order =
              data.orders.find((o) => o.id === table.orderId) ||
              data.orders.find(
                (o) =>
                  o.tableId === table.id &&
                  !["completed", "cancelled"].includes(o.status),
              );
            return (
              <button
                key={table.id}
                className={`panel floor-table ${table.status}`}
                onClick={() => (order ? onOpen(order.id) : onNew(table.id))}
              >
                <div className="floor-table-top">
                  <span>{table.area}</span>
                  <StatusBadge status={table.status} />
                </div>
                <div className={`table-illustration seats-${table.seats}`}>
                  <i className="chair chair-top-left" />
                  <i className="chair chair-top-right" />
                  <i className="chair chair-bottom-left" />
                  <i className="chair chair-bottom-right" />
                  {table.seats > 4 && (
                    <>
                      <i className="chair chair-left" />
                      <i className="chair chair-right" />
                    </>
                  )}
                  <div className="table-surface">
                    <UtensilsCrossed size={22} />
                  </div>
                </div>
                <h3>{table.name}</h3>
                <span className="table-seats">{table.seats} seats</span>
                <div className="floor-table-bottom">
                  {order ? (
                    <>
                      <strong>{money(order.total)}</strong>
                      <span>
                        {elapsed(order.createdAt)} min <ArrowRight size={12} />
                      </span>
                    </>
                  ) : (
                    <>
                      <span>Ready for guests</span>
                      <Plus size={14} />
                    </>
                  )}
                </div>
              </button>
            );
          })}
      </div>
    </>
  );
}

export function Receipt({
  order,
  branch,
  settings,
  onClose,
}: {
  order: Order;
  branch: Branch;
  settings: Settings;
  onClose: () => void;
}) {
  useDevicePreferences();
  const dimensions = receiptDimensions(settings);
  const itemDiscount = order.lines.reduce(
    (sum, line) => sum + (line.discount || 0),
    0,
  );
  const hasItemDiscountMetadata = order.lines.some(
    (line) => line.discount !== undefined,
  );
  const cartDiscount =
    order.cartDiscount ??
    (hasItemDiscountMetadata
      ? Math.max(0, order.discount - itemDiscount)
      : order.discount);
  const content = (
    <>
      <h2>{settings.businessName || "DEMO HOTEL"}</h2>
      <p>
        {branch.name}
        <br />
        {branch.address}
        <br />
        {branch.phone}
      </p>
      <div className="receipt-meta">
        <div>
          <span>Receipt</span>
          <strong>{order.number}</strong>
        </div>
        <div>
          <span>Date</span>
          <span>{dateTime(order.createdAt)}</span>
        </div>
        <div>
          <span>Service</span>
          <span>{order.type.replace("-", " ")}</span>
        </div>
        <div>
          <span>Payment</span>
          <span>{order.paymentStatus.toUpperCase()}</span>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {order.lines.map((l) => (
            <tr key={l.id}>
              <td>
                {l.quantity} × {l.name}
                {(l.discount || 0) > 0 && (
                  <small style={{ display: "block", fontSize: ".85em" }}>
                    Item discount − {money(l.discount || 0)}
                  </small>
                )}
              </td>
              <td>{money(l.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="receipt-totals">
        <div>
          <span>Subtotal</span>
          <span>{money(order.subtotal)}</span>
        </div>
        {itemDiscount > 0 && (
          <div>
            <span>Item discounts</span>
            <span>− {money(itemDiscount)}</span>
          </div>
        )}
        {cartDiscount > 0 && (
          <div>
            <span>
              {hasItemDiscountMetadata || order.cartDiscount !== undefined
                ? "Cart discount"
                : "Discount"}
            </span>
            <span>− {money(cartDiscount)}</span>
          </div>
        )}
        <div>
          <span>Service charge</span>
          <span>{money(order.serviceCharge)}</span>
        </div>
        <div>
          <span>Tax</span>
          <span>{money(order.tax)}</span>
        </div>
        <div className="total">
          <strong>Total</strong>
          <strong>{money(order.total)}</strong>
        </div>
        <div>
          <span>Paid</span>
          <span>{money(order.paid)}</span>
        </div>
        {order.refunded > 0 && (
          <div>
            <span>Refunded</span>
            <span>{money(order.refunded)}</span>
          </div>
        )}
        {order.payments.map((p) => (
          <div key={p.id}>
            <span>
              {p.method.toUpperCase()}
              {p.change > 0 ? " · change" : ""}
            </span>
            <span>{money(p.change > 0 ? p.change : p.amount)}</span>
          </div>
        ))}
      </div>
      <p className="receipt-thanks">
        {settings.receiptFooter || "Thank you for dining with us."}
      </p>
      <p className="receipt-copy">COPY · Retain for your records</p>
    </>
  );
  return (
    <>
      <Modal title="Order receipt" subtitle={order.number} onClose={onClose}>
        <div
          className="receipt-preview"
          style={
            {
              width: `min(100%, ${dimensions.content}mm)`,
              "--font-scale": 1,
            } as CSSProperties
          }
        >
          {content}
        </div>
        <p className="preference-note" style={{ textAlign: "center" }}>
          {dimensions.paper} mm paper · {dimensions.content} mm content ·{" "}
          {dimensions.offset} mm offset. Match the printer dialog's paper size
          to this layout.
        </p>
        <div className="form-actions">
          <button className="button button-ghost" onClick={onClose}>
            Close
          </button>
          <button
            className="button button-primary"
            onClick={() => window.print()}
          >
            <Printer size={14} /> Print receipt
          </button>
        </div>
      </Modal>
      <style>
        {receiptPrintCss(settings) +
          " @media print{.print-receipt .total{font-size:1.1em!important}.print-receipt .receipt-copy{font-size:.7em!important}.print-receipt th:first-child{text-align:left}}"}
      </style>
      <div className="print-receipt">{content}</div>
    </>
  );
}
