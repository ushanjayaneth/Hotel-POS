import ProductPhoto from '../components/ProductPhoto';
import PhotoPicker from '../components/PhotoPicker';
import ProfitSummary from '../components/ProfitSummary';
import {apiResponse} from '../lib/api';
import {isDeviceWorkspace} from '../lib/workspace-mode';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Banknote,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Cloud,
  Coffee,
  CreditCard,
  Download,
  Flame,
  Layers3,
  Package,
  Plus,
  ReceiptText,
  Search,
  ShieldCheck,
  ShoppingBag,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
  Truck,
  Users,
  Wallet,
  X,
} from "lucide-react";
import type {
  InventoryItem,
  MenuItem,
  Page,
  Settings,
  Shift,
} from "../../shared/types";
import { usePOS } from "../lib/context";
import { portionIngredients } from "../../shared/costing";
import { money, number, dateTime, commandId } from "../lib/format";
import { useBackLayer } from "../lib/navigation";
import { WorkspacePreferences } from "../components/WorkspacePreferences";
import "../styles/management.css";
type Dialog =
  | "stock"
  | "inventory-create"
  | "supplier"
  | "menu"
  | "recipe"
  | "production"
  | "purchase"
  | "customer"
  | "customer-ledger"
  | "staff"
  | "expense"
  | "shift-open"
  | "shift-close"
  | null;
type Range = "today" | "week" | "month" | "all";
const minor = (value: FormDataEntryValue | null) =>
  Math.round(Number(value || 0) * 100);
const value = (data: FormData, key: string) =>
  String(data.get(key) || "").trim();
const dayKey = (date: string | Date) =>
  new Date(date).toLocaleDateString("en-CA", { timeZone: "Asia/Colombo" });
const isWithin = (date: string, range: Range, now: string) => {
  if (range === "all") return true;
  if (range === "today") return dayKey(date) === dayKey(now);
  return (
    new Date(date).getTime() >=
    new Date(now).getTime() - (range === "week" ? 7 : 30) * 86400000
  );
};
function Modal({
  title,
  subtitle,
  children,
  close,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  close: () => unknown;
}) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useBackLayer(true, () => closeRef.current(), `management:${title}`);
  useEffect(() => {
    const fn = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key === "Tab") {
        const focusable = Array.from(
          document.querySelectorAll<HTMLElement>(
            ".management-modal input:not([disabled]), .management-modal select:not([disabled]), .management-modal textarea:not([disabled]), .management-modal button:not([disabled])",
          ),
        );
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", fn);
    const previous = document.activeElement as HTMLElement | null;
    document.querySelector<HTMLElement>(
      ".management-modal input, .management-modal select",
    )?.focus();
    return () => {
      document.removeEventListener("keydown", fn);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        className="modal management-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="management-modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close"
            onClick={close}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
function Stat({
  label,
  amount,
  note,
  icon,
  accent,
  trend,
}: {
  label: string;
  amount: ReactNode;
  note: string;
  icon: ReactNode;
  accent?: boolean;
  trend?: string;
}) {
  return (
    <article className={`stat-card panel ${accent ? "stat-card-accent" : ""}`}>
      <div className="stat-top">
        <span>{label}</span>
        <span className="stat-icon">{icon}</span>
      </div>
      <strong>{amount}</strong>
      <div className="stat-foot">
        {trend && (
          <span className="stat-trend">
            <ArrowUpRight size={12} />
            {trend}
          </span>
        )}
        <span>{note}</span>
      </div>
    </article>
  );
}
function Empty({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="management-empty">
      <Package size={28} />
      <strong>{title}</strong>
      {subtitle && <span>{subtitle}</span>}
    </div>
  );
}
function Field({
  label,
  children,
  full,
}: {
  label: string;
  children: ReactNode;
  full?: boolean;
}) {
  return (
    <label className={`field ${full ? "field-full" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}
function Pill({ children, tone = "" }: { children: ReactNode; tone?: string }) {
  return <span className={`management-pill ${tone}`}>{children}</span>;
}
function SearchField({
  value: search,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="management-search">
      <Search size={16} />
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={search}
        onChange={(event) => onChange(event.target.value)}
      />
      {search && (
        <button
          className="icon-button"
          onClick={() => onChange("")}
          aria-label="Clear search"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
function downloadCSV(filename: string, rows: (string | number)[][]) {
  const content =
    "\ufeff" +
    rows
      .map((row) =>
        row
          .map((cell) => '"' + String(cell).replaceAll('"', '""') + '"')
          .join(","),
      )
      .join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(
    new Blob([content], { type: "text/csv;charset=utf-8" }),
  );
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}
export default function Management({ page }: { page: Page }) {
  const { data, branchId, locale, mutate, notify, refresh } = usePOS();
  const [search, setSearch] = useState("");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [range, setRange] = useState<Range>("today");
  const [category, setCategory] = useState("all");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [formCommandId, setFormCommandId] = useState<string>(commandId);
  const [editingMenu, setEditingMenu] = useState<MenuItem | null>(null);
  const [menuPhoto,setMenuPhoto]=useState("");
  const [menuPhotoBusy,setMenuPhotoBusy]=useState(false);
  const [stockCategory, setStockCategory] =
    useState<InventoryItem["category"]>("ingredient");
  const [menuStockMode, setMenuStockMode] =
    useState<MenuItem["stockMode"]>("prepared");
  const [recipeLines, setRecipeLines] = useState<
    { key: string; quantity: string }[]
  >([{ key: "", quantity: "" }]);
  const [recipeYield, setRecipeYield] = useState("1");
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const [selectedShift, setSelectedShift] = useState<Shift | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(
    null,
  );
  const [reportFrom, setReportFrom] = useState(dayKey(data.serverTime));
  const [reportTo, setReportTo] = useState(dayKey(data.serverTime));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [purchaseLines, setPurchaseLines] = useState<
    {
      itemId: string;
      quantity: string;
      unitCost: string;
    }[]
  >([{ itemId: "", quantity: "1", unitCost: "" }]);
  const [productionMenuId, setProductionMenuId] = useState("");
  const [productionQuantity, setProductionQuantity] = useState("10");
  const [settings, setSettings] = useState<Settings>(data.settings);
  useEffect(() => {
    setSearch("");
    setCategory("all");
    setDialog(null);
    setError("");
  }, [page, branchId]);
  useEffect(() => {
    setSettings(data.settings);
  }, [data.settings]);
  const branch =
    data.branches.find((branch) => branch.id === branchId) || data.branch;
  const label = (item: { name: string; nameSi?: string }) =>
    locale === "si" && item.nameSi ? item.nameSi : item.name;
  const orders = data.orders.filter(
    (order) => order.branchId === branchId && order.status !== "cancelled",
  );
  const periodOrders = orders.filter((order) =>
    isWithin(order.createdAt, range, data.serverTime),
  );
  const completed = periodOrders.filter(
    (order) => order.paymentStatus === "paid" && order.status !== "cancelled",
  );
  const revenue = completed.reduce(
    (sum, order) => sum + order.total - order.refunded,
    0,
  );
  const inventory = data.inventory.filter((item) => item.branchId === branchId);
  const lowStock = inventory.filter((item) => item.quantity <= item.minimum);
  const expenses = data.expenses.filter(
    (expense) =>
      expense.branchId === branchId &&
      isWithin(expense.createdAt, range, data.serverTime),
  );
  const expenseTotal = expenses.reduce(
    (sum, expense) => sum + expense.amount,
    0,
  );
  const stockValue = inventory.reduce(
    (sum, item) => sum + item.quantity * item.unitCost,
    0,
  );
  const activeShift = data.shifts.find(
    (shift) => shift.branchId === branchId && shift.status === "open",
  );
  const visibleInventory = inventory.filter(
    (item) =>
      (category === "all" ||
        item.category === category ||
        (category === "low" && item.quantity <= item.minimum)) &&
      `${item.name} ${item.nameSi} ${item.unit}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const preparedMenu = data.menu.filter(
    (item) => item.stockMode === "prepared",
  );
  const cashSales = completed.reduce(
    (sum, order) =>
      sum +
      order.payments
        .filter((payment) => payment.method === "cash")
        .reduce((s, payment) => s + payment.amount, 0),
    0,
  );
  const cardSales = completed.reduce(
    (sum, order) =>
      sum +
      order.payments
        .filter((payment) => payment.method === "card")
        .reduce((s, payment) => s + payment.amount, 0),
    0,
  );
  const open = (next: Dialog) => {
    setError("");
    setFormCommandId(commandId());
    setDialog(next);
  };
  const close = () => {
    if (busy || menuPhotoBusy) return false;
    setDialog(null);
    setError("");
    return true;
  };
  const submit = async (
    event: FormEvent<HTMLFormElement>,
    action: (fields: FormData) => Promise<unknown>,
    success: string,
  ) => {
    event.preventDefault();
    if (busy || menuPhotoBusy) return;
    setBusy(true);
    setError("");
    try {
      await action(new FormData(event.currentTarget));
      await refresh();
      setDialog(null);
      notify(success);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to save. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  const run = async (action: () => Promise<unknown>, success: string) => {
    if (busy || menuPhotoBusy) return;
    setBusy(true);
    try {
      await action();
      await refresh();
      notify(success);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "Action failed", "error");
    } finally {
      setBusy(false);
    }
  };
  const footer = (text: string) => (
    <>
      <div className="form-error" role="alert">
        {error}
      </div>
      <div className="form-actions">
        <button
          type="button"
          className="button button-ghost"
          onClick={close}
          disabled={busy}
        >
          {"Cancel"}
        </button>
        <button type="submit" className="button button-primary" disabled={busy || menuPhotoBusy}>
          {busy ? "Saving…" : text}
          <Check size={16} />
        </button>
      </div>
    </>
  );
  const rangeControl = (
    <div className="management-date">
      <CalendarDays size={15} />
      <select
        aria-label={"Date range"}
        value={range}
        onChange={(event) => setRange(event.target.value as Range)}
      >
        <option value="today">{"Today"}</option>
        <option value="week">{"Last 7 days"}</option>
        <option value="month">{"Last 30 days"}</option>
        <option value="all">{"All time"}</option>
      </select>
      <ChevronDown size={14} />
    </div>
  );
  const headings: Partial<Record<Page, [string, string, string, string]>> = {
    overview: [
      "Business overview",
      "",
      "A clear picture of your restaurant, in real time.",
      "",
    ],
    inventory: [
      "Inventory",
      "",
      "Every ingredient. Every portion. Accounted for.",
      "",
    ],
    production: [
      "Kitchen production",
      "",
      "Prepare thoughtfully. Track every batch.",
      "",
    ],
    purchases: [
      "Purchases & suppliers",
      "",
      "Keep your supply chain running smoothly.",
      "",
    ],
    customers: [
      "Customers & dues",
      "",
      "Good food brings them in. Great service brings them back.",
      "",
    ],
    team: ["Your team", "", "The people who make it all happen.", ""],
    finance: ["Day end & expenses", "", "Know where every rupee goes.", ""],
    reports: [
      "Reports & insights",
      "",
      "Turn your everyday numbers into better decisions.",
      "",
    ],
    settings: [
      "Workspace settings",
      "",
      "Set up DEMO HOTEL for the way you work.",
      "",
    ],
  };
  const heading = headings[page] || headings.overview!;
  const header = (
    <header className="management-page-heading">
      <div>
        <div className="management-eyebrow">
          <span className="live-dot" />
          {label(branch)}
          <span className="eyebrow-separator">/</span>WORKSPACE
        </div>
        <h1>{heading[0]}</h1>
        <p>{heading[2]}</p>
      </div>
      <div className="management-heading-actions">
        {["overview", "finance", "reports", "purchases", "production"].includes(
          page,
        ) && rangeControl}
        {page === "inventory" && (
          <button
            className="button button-ghost"
            onClick={() => {
              setStockCategory("ingredient");
              open("inventory-create");
            }}
          >
            <Plus size={16} />
            Add item
          </button>
        )}
        {page === "inventory" && (
          <button
            className="button button-primary"
            onClick={() => {
              setSelectedItem(null);
              open("stock");
            }}
          >
            <Plus size={16} />
            {"Adjust stock"}
          </button>
        )}
        {page === "production" && (
          <button
            className="button button-primary"
            onClick={() => {
              setProductionMenuId(preparedMenu[0]?.id || "");
              setProductionQuantity("10");
              open("production");
            }}
          >
            <Plus size={16} />
            {"New batch"}
          </button>
        )}
        {page === "purchases" && (
          <button
            className="button button-ghost"
            onClick={() => open("supplier")}
          >
            <Plus size={16} />
            Add supplier
          </button>
        )}
        {page === "purchases" && (
          <button
            className="button button-primary"
            onClick={() => {
              setPurchaseLines([{ itemId: "", quantity: "1", unitCost: "" }]);
              open("purchase");
            }}
          >
            <Plus size={16} />
            {"Add purchase"}
          </button>
        )}
        {page === "customers" && (
          <button
            className="button button-primary"
            onClick={() => open("customer")}
          >
            <Plus size={16} />
            {"Add customer"}
          </button>
        )}
        {page === "team" && (
          <button
            className="button button-primary"
            onClick={() => open("staff")}
          >
            <Plus size={16} />
            {"Add member"}
          </button>
        )}
        {page === "finance" && (
          <button
            className="button button-ghost"
            onClick={() => exportDayEnd()}
          >
            <Download size={15} />
            Day-end CSV
          </button>
        )}
        {page === "finance" && (
          <button
            className="button button-primary"
            onClick={() => open("expense")}
          >
            <Plus size={16} />
            {"Add expense"}
          </button>
        )}
        {page === "reports" && (
          <button
            className="button button-ghost"
            onClick={() => {
              downloadCSV(`demo-hotel-sales-${dayKey(data.serverTime)}.csv`, [
                [
                  "Order",
                  "Date",
                  "Type",
                  "Status",
                  "Subtotal (LKR)",
                  "Discount (LKR)",
                  "Total (LKR)",
                  "Paid (LKR)",
                  "Refunded (LKR)",
                ],
                ...periodOrders.map((order) => [
                  order.number,
                  order.createdAt,
                  order.type,
                  order.paymentStatus,
                  order.subtotal / 100,
                  order.discount / 100,
                  order.total / 100,
                  order.paid / 100,
                  order.refunded / 100,
                ]),
              ]);
              notify("Sales report downloaded");
            }}
          >
            <Download size={16} />
            {"Export CSV"}
          </button>
        )}
      </div>
    </header>
  );
  const stats = (
    <div className="management-stats">
      <Stat
        label={"Total revenue"}
        amount={money(revenue)}
        note={"From settled orders"}
        icon={<CircleDollarSign size={18} />}
        accent
      />
      <Stat
        label={"Orders completed"}
        amount={number(completed.length)}
        note={`${periodOrders.filter((order) => order.paymentStatus !== "paid").length} ${"orders in progress"}`}
        icon={<ShoppingBag size={18} />}
      />
      <Stat
        label={"Average order"}
        amount={money(
          completed.length ? Math.round(revenue / completed.length) : 0,
        )}
        note={"Per settled order"}
        icon={<ReceiptText size={18} />}
      />
      <Stat
        label={"Cash collected"}
        amount={money(cashSales)}
        note={`${"Card"} · ${money(cardSales)}`}
        icon={<Wallet size={18} />}
      />
    </div>
  );
  const topItems = useMemo(() => {
    const items = new Map<
      string,
      {
        name: string;
        nameSi: string;
        count: number;
        revenue: number;
        image: string;
      }
    >();
    completed.forEach((order) =>
      order.lines.forEach((line) => {
        const item = items.get(line.menuItemId) || {
          name: line.name,
          nameSi: line.nameSi,
          count: 0,
          revenue: 0,
          image:
            data.menu.find((menu) => menu.id === line.menuItemId)?.image || "",
        };
        item.count += line.quantity;
        item.revenue += line.lineTotal;
        items.set(line.menuItemId, item);
      }),
    );
    return Array.from(items.values()).sort((a, b) => b.revenue - a.revenue);
  }, [completed, data.menu]);
  const salesChart = (() => {
    const end = new Date(data.serverTime).getTime() + 1;
    const start =
      range === "all"
        ? Math.min(
            ...completed.map((order) => new Date(order.createdAt).getTime()),
            end - 6 * 86400000,
          )
        : end - (range === "week" ? 7 : 30) * 86400000;
    const interval = Math.max(1, (end - start) / 7);
    const buckets =
      range === "today"
        ? Array.from({ length: 12 }, (_, index) => ({
            label: `${String(index * 2).padStart(2, "0")}:00`,
            amount: 0,
            index,
          }))
        : Array.from({ length: 7 }, (_, index) => ({
            label: new Date(start + index * interval).toLocaleDateString(
              "en-US",
              { month: "short", day: "numeric", timeZone: "Asia/Colombo" },
            ),
            amount: 0,
            index,
          }));
    completed.forEach((order) => {
      const index =
        range === "today"
          ? Math.floor(
              Number(
                new Date(order.createdAt).toLocaleString("en-US", {
                  hour: "numeric",
                  hour12: false,
                  timeZone: "Asia/Colombo",
                }),
              ) / 2,
            ) % 12
          : Math.min(
              6,
              Math.floor(
                (new Date(order.createdAt).getTime() - start) / interval,
              ),
            );
      if (index >= 0 && buckets[index])
        buckets[index].amount += order.total - order.refunded;
    });
    const max = Math.max(...buckets.map((bucket) => bucket.amount), 10000);
    const width = 700;
    const height = 180;
    const points = buckets.map((bucket, index) => ({
      x: 18 + (index * (width - 36)) / (buckets.length - 1),
      y: height - 14 - (bucket.amount / max) * (height - 40),
    }));
    const path = points
      .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
      .join(" ");
    return (
      <div className="sales-chart">
        <div className="chart-y-labels">
          <span>{money(max)}</span>
          <span>{money(Math.round(max / 2))}</span>
          <span>0</span>
        </div>
        <div className="chart-canvas">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={"Sales over time"}
            preserveAspectRatio="none"
          >
            <defs>
              <linearGradient id="sales-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#b7f67a" stopOpacity="0.22" />
                <stop offset="100%" stopColor="#b7f67a" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[30, 95, 166].map((y) => (
              <line
                key={y}
                x1="0"
                x2="700"
                y1={y}
                y2={y}
                stroke="rgba(255,255,255,.055)"
                strokeDasharray="4 5"
              />
            ))}
            <path
              d={`${path} L ${points.at(-1)?.x} ${height} L 18 ${height} Z`}
              fill="url(#sales-fill)"
            />
            <path
              d={path}
              fill="none"
              stroke="#b7f67a"
              strokeWidth="2.6"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            {points.map((point, index) => (
              <circle
                key={index}
                cx={point.x}
                cy={point.y}
                r={buckets[index].amount ? 3.5 : 0}
                fill="#b7f67a"
              >
                <title>
                  {buckets[index].label}: {money(buckets[index].amount)}
                </title>
              </circle>
            ))}
          </svg>
          <div className="chart-x-labels">
            {buckets.map((bucket, index) => (
              <span key={index}>{bucket.label}</span>
            ))}
          </div>
        </div>
      </div>
    );
  })();
  const methods = [
    { key: "cash", label: "Cash", color: "#b7f67a" },
    { key: "card", label: "Card", color: "#99bafc" },
    { key: "qr", label: "QR", color: "#cab0f5" },
    { key: "credit", label: "Credit", color: "#f0b77a" },
  ].map((method) => ({
    ...method,
    amount: completed.reduce(
      (sum, order) =>
        sum +
        order.payments
          .filter((payment) => payment.method === method.key)
          .reduce((s, payment) => s + payment.amount, 0),
      0,
    ),
  }));
  const paymentTotal = methods.reduce((sum, method) => sum + method.amount, 0);
  let chartOffset = 0;
  const paymentCard = (
    <section className="panel management-payment">
      <div className="management-card-heading">
        <div>
          <h2>{"Payment breakdown"}</h2>
          <p>{"How your guests paid"}</p>
        </div>
        <CreditCard size={18} />
      </div>
      <div className="payment-donut">
        <svg viewBox="0 0 160 160" role="img" aria-label={"Payments by method"}>
          <circle
            cx="80"
            cy="80"
            r="60"
            fill="none"
            stroke="rgba(255,255,255,.045)"
            strokeWidth="15"
          />
          {methods.map((method) => {
            const percent = paymentTotal ? method.amount / paymentTotal : 0;
            const offset = chartOffset;
            chartOffset += percent * 377;
            return (
              <circle
                key={method.key}
                cx="80"
                cy="80"
                r="60"
                fill="none"
                stroke={method.color}
                strokeWidth="15"
                strokeDasharray={`${percent * 377} 377`}
                strokeDashoffset={-offset}
                transform="rotate(-90 80 80)"
              />
            );
          })}
        </svg>
        <div>
          <span>{"Collected"}</span>
          <strong>{money(paymentTotal)}</strong>
        </div>
      </div>
      <div className="payment-legend">
        {methods.map((method) => (
          <div key={method.key}>
            <span>
              <i style={{ background: method.color }} />
              {method.label}
            </span>
            <strong>
              {paymentTotal
                ? Math.round((method.amount / paymentTotal) * 100)
                : 0}
              %
            </strong>
            <span>{money(method.amount)}</span>
          </div>
        ))}
      </div>
    </section>
  );
  const ingredientKey = (item: InventoryItem) =>
    item.id.startsWith(`${branchId}-`)
      ? item.id.slice(branchId.length + 1)
      : item.id;
  const ingredients = inventory.filter(
    (item) => ["ingredient", "packaging"].includes(item.category),
  );
  const recipeBatchCost = Math.round(recipeLines.reduce((sum, line) => sum +
    (ingredients.find(item => ingredientKey(item) === line.key)?.unitCost || 0) * Number(line.quantity || 0), 0));
  const recipePortionCost = Number(recipeYield) > 0 ? Math.round(recipeBatchCost / Number(recipeYield)) : 0;
  const startRecipe = (item: MenuItem) => {
    setEditingMenu(item);
    const recipe = data.recipes?.find((recipe) => recipe.id === item.id);
    const batchYield = recipe?.batchYield || 1;
    setRecipeYield(String(batchYield));
    setRecipeLines(
      recipe?.ingredients.length
        ? recipe.ingredients.map((line) => ({
            key: line.key,
            quantity: String(Math.round(line.quantity * batchYield * 100000000) / 100000000),
          }))
        : [{ key: "", quantity: "" }],
    );
    open("recipe");
  };
  const startMenu = (item: MenuItem | null) => {
    setEditingMenu(item);
    setMenuStockMode(item?.stockMode || "prepared");
    setMenuPhoto(item?.image||"");setMenuPhotoBusy(false);
    open("menu");
  };
  const menuCatalog = (
    <section className="panel management-table-panel menu-catalog">
      <div className="management-table-toolbar">
        <div>
          <h2>
            Menu & recipes<span className="count-pill">{data.menu.length}</span>
          </h2>
          <p className="catalog-intro">
            Your menu, pricing and ingredient quantities per portion.
          </p>
        </div>
        <div className="catalog-actions">
          <SearchField
            value={catalogSearch}
            onChange={setCatalogSearch}
            placeholder="Find a menu item…"
          />
          {data.user.role === "owner" && (
            <button
              className="button button-primary button-small"
              onClick={() => startMenu(null)}
            >
              <Plus size={14} />
              Add dish
            </button>
          )}
        </div>
      </div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Menu item</th>
              <th>Category</th>
              <th>Selling price</th>
              <th>Cost per portion</th>
              <th>Stock tracking</th>
              <th>Recipe</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.menu
              .filter((item) =>
                item.name.toLowerCase().includes(catalogSearch.toLowerCase()),
              )
              .map((item) => {
                const recipe = data.recipes?.find(
                  (recipe) => recipe.id === item.id,
                );
                return (
                  <tr key={item.id}>
                    <td>
                      <div className="table-item">
                        <div className="catalog-food-image">
                          {item.image ? (
                            <ProductPhoto src={item.image} alt="" />
                          ) : (
                            <Coffee size={18} />
                          )}
                        </div>
                        <div>
                          <strong>{item.name}</strong>
                          <small>{item.preparationMinutes} MIN PREP</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      {data.categories.find(
                        (category) => category.id === item.categoryId,
                      )?.name || "—"}
                    </td>
                    <td>
                      <strong>{money(item.price)}</strong>
                    </td>
                    <td>{money(item.cost)}</td>
                    <td>
                      <Pill
                        tone={item.stockMode === "untracked" ? "" : "green"}
                      >
                        {item.stockMode === "prepared"
                          ? "Prepared portions"
                          : item.stockMode === "recipe"
                            ? "Recipe ingredients"
                            : "Untracked"}
                      </Pill>
                    </td>
                    <td>
                      {item.stockMode === "untracked" ? (
                        <span className="muted">Not required</span>
                      ) : data.user.role === "owner" ? (
                        <button
                          className="button button-ghost button-small"
                          onClick={() => startRecipe(item)}
                        >
                          <BookOpen size={13} />
                          {recipe
                            ? `${recipe.ingredients.length} ingredients`
                            : "Set up recipe"}
                        </button>
                      ) : (
                        <span className="muted">
                          {recipe
                            ? `${recipe.ingredients.length} ingredients`
                            : "Not configured"}
                        </span>
                      )}
                    </td>
                    <td>
                      {data.user.role === "owner" && (
                        <button
                          className="button button-ghost button-small"
                          onClick={() => startMenu(item)}
                        >
                          <SlidersHorizontal size={13} />
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
        {!data.menu.some((item) =>
          item.name.toLowerCase().includes(catalogSearch.toLowerCase()),
        ) && <Empty title="No matching menu items" />}
      </div>
      <div className="management-table-footer">
        <span>
          <BookOpen size={13} />
          Recipe quantities are per portion, in each ingredient’s stock unit.
        </span>
        <span>Menu changes apply to all branches</span>
      </div>
    </section>
  );
  const selectedCustomer = data.customers.find(
    (customer) => customer.id === selectedCustomerId,
  );
  const customerEntries = data.creditEntries
    .filter(
      (entry) =>
        entry.customerId === selectedCustomerId && entry.branchId === branchId,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const visibleCustomers = data.customers.filter((customer) =>
    `${customer.name} ${customer.phone} ${customer.email}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const showLedger = (id: string) => {
    setSelectedCustomerId(id);
    open("customer-ledger");
  };
  const customerView = (
    <>
      <div className="management-stats three">
        <Stat
          label="Registered customers"
          amount={number(data.customers.length)}
          note="Your growing guest directory"
          icon={<Users size={18} />}
          accent
        />
        <Stat
          label="Customer lifetime sales"
          amount={money(
            data.customers.reduce((sum, customer) => sum + customer.spent, 0),
          )}
          note="Across recorded customer purchases"
          icon={<CircleDollarSign size={18} />}
        />
        <Stat
          label="Outstanding dues"
          amount={money(
            data.customers.reduce((sum, customer) => sum + customer.balance, 0),
          )}
          note={`Receivables at ${data.branch.name}`}
          icon={<Wallet size={18} />}
        />
      </div>
      <section className="panel management-table-panel">
        <div className="management-table-toolbar">
          <h2>
            Customers & dues
            <span className="count-pill">{data.customers.length}</span>
          </h2>
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder="Name, phone or email…"
          />
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Phone</th>
                <th>Visits</th>
                <th>Total spent</th>
                <th>Branch dues</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visibleCustomers.map((customer, index) => (
                <tr key={customer.id}>
                  <td>
                    <div className="table-item">
                      <span className={`guest-avatar color-${index % 4}`}>
                        {customer.name
                          .split(" ")
                          .slice(0, 2)
                          .map((word) => word[0])
                          .join("")
                          .toUpperCase()}
                      </span>
                      <div>
                        <strong>{customer.name}</strong>
                        <small>{customer.email || "Registered customer"}</small>
                      </div>
                    </div>
                  </td>
                  <td>{customer.phone || "—"}</td>
                  <td>{number(customer.visits)}</td>
                  <td>{money(customer.spent)}</td>
                  <td>
                    <Pill tone={customer.balance > 0 ? "amber" : "green"}>
                      {customer.balance > 0
                        ? money(customer.balance)
                        : "No dues"}
                    </Pill>
                  </td>
                  <td>
                    <button
                      className="button button-ghost button-small"
                      onClick={() => showLedger(customer.id)}
                    >
                      <BookOpen size={13} />
                      {customer.balance > 0
                        ? "Ledger & collect"
                        : "View ledger"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!visibleCustomers.length && (
            <Empty
              title="No customers found"
              subtitle="Add a customer to start keeping a clear account of their purchases."
            />
          )}
        </div>
        <div className="management-table-footer">
          <span>
            <ShieldCheck size={13} />
            Credit sales, refunds and collections keep the ledger up to date.
          </span>
          <span>Dues shown for the selected branch</span>
        </div>
      </section>
    </>
  );
  const exportDayEnd = () => {
    const shifts = data.shifts.filter(
      (shift) =>
        shift.branchId === branchId &&
        isWithin(shift.openedAt, range, data.serverTime),
    );
    downloadCSV(`demo-hotel-day-end-${dayKey(data.serverTime)}.csv`, [
      ["DEMO HOTEL — Day-end reconciliation"],
      ["Branch", data.branch.name],
      ["Period", range],
      ["Generated", dateTime(data.serverTime)],
      ["Settled sales (LKR)", revenue / 100],
      ["Recorded expenses (LKR)", expenseTotal / 100],
      [
        "Sales less expenses before food costs (LKR)",
        (revenue - expenseTotal) / 100,
      ],
      [],
      [
        "Shift ID",
        "Opened at",
        "Closed at",
        "Status",
        "Opening float (LKR)",
        "Expected cash (LKR)",
        "Counted cash (LKR)",
        "Variance (LKR)",
      ],
      ...shifts.map((shift) => [
        shift.id,
        shift.openedAt,
        shift.closedAt || "",
        shift.status,
        shift.openingFloat / 100,
        shift.expectedCash / 100,
        shift.countedCash === null ? "" : shift.countedCash / 100,
        shift.variance === null ? "" : shift.variance / 100,
      ]),
    ]);
    notify("Day-end reconciliation downloaded");
  };
  const reportURL = (format: "csv" | "json") =>
    `/api/reports/income-expenses?${new URLSearchParams({ branchId, from: reportFrom, to: reportTo, format })}`;
  const downloadIncomeExpense = async () => {
    if (!reportFrom || !reportTo || reportFrom > reportTo) {
      notify("Choose a valid start and end date.", "error");
      return;
    }
    setBusy(true);
    try {
      const response = await apiResponse(reportURL("csv"));
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error || "Unable to download the report.");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `demo-hotel-income-expenses-${reportFrom}-${reportTo}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      notify("Income & expense report downloaded");
    } catch (cause) {
      notify(
        cause instanceof Error
          ? cause.message
          : "Unable to download the report.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  };
  const printIncomeExpense = async () => {
    if (!reportFrom || !reportTo || reportFrom > reportTo) {
      notify("Choose a valid start and end date.", "error");
      return;
    }
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      notify("Allow pop-ups to open the printable report.", "error");
      return;
    }
    printWindow.document.write(
      '<title>Preparing report</title><p style="font:14px system-ui;padding:30px">Preparing your report…</p>',
    );
    setBusy(true);
    const escape = (input: unknown) =>
      String(input ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    try {
      const response = await apiResponse(reportURL("json"));
      const report = (await response.json()) as {
        error?: string;
        income: number;
        expense: number;
        net: number;
        rows: Record<string, unknown>[];
      };
      if (!response.ok)
        throw new Error(report.error || "Unable to prepare the report.");
      const rows = report.rows
        .map(
          (row) =>
            `<tr><td>${escape(row.date || row.createdAt)}</td><td>${escape(row.type)}</td><td>${escape(row.description || row.reference || "")}</td><td>${escape(row.method || row.paymentMethod || "")}</td><td class="amount">${escape(money(Number(row.income || row.expense || 0)))}</td></tr>`,
        )
        .join("");
      printWindow.document.open();
      printWindow.document.write(
        `<!doctype html><html lang="en"><head><title>Income & expenses — DEMO HOTEL</title><style>body{font:12px Arial,sans-serif;color:#17251d;padding:35px}h1{font-size:24px;margin:0 0 7px}p{color:#627267}.summary{display:flex;gap:45px;border-block:1px solid #cbd5ce;padding:20px 0;margin:25px 0}.summary strong{display:block;font-size:18px;margin-top:8px}table{border-collapse:collapse;width:100%;font-size:11px}th,td{text-align:left;padding:11px 8px;border-bottom:1px solid #dde3df}.amount{text-align:right}footer{color:#7b8a80;margin-top:30px;font-size:10px}@page{size:A4;margin:15mm}@media print{body{padding:0}}</style></head><body><h1>${escape(data.settings.businessName)}</h1><p>Income & expense report · ${escape(data.branch.name)}<br>${escape(reportFrom)} to ${escape(reportTo)}</p><div class="summary"><div>Income received<strong>${escape(money(report.income))}</strong></div><div>Expenses paid<strong>${escape(money(report.expense))}</strong></div><div>Net cash flow<strong>${escape(money(report.net))}</strong></div></div><table><thead><tr><th>Date</th><th>Type</th><th>Description</th><th>Method</th><th class="amount">Amount</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No transactions in this period.</td></tr>'}</tbody></table><footer>Generated ${escape(dateTime(data.serverTime))} · Credit sales are recognised as income when collected.</footer></body></html>`,
      );
      printWindow.document.close();
      printWindow.focus();
      printWindow.print();
    } catch (cause) {
      printWindow.close();
      notify(
        cause instanceof Error
          ? cause.message
          : "Unable to prepare the report.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  };
  const financialDownloads = (
    <section className="panel financial-downloads">
      <div>
        <span className="financial-download-icon">
          <Download size={21} />
        </span>
        <div>
          <h2>Income & expense statement</h2>
          <p>
            Download recorded cash flow, including customer collections and
            refunds.
          </p>
        </div>
      </div>
      <div className="financial-download-controls">
        <Field label="From">
          <input
            className="input"
            type="date"
            value={reportFrom}
            max={reportTo}
            onChange={(event) => setReportFrom(event.target.value)}
          />
        </Field>
        <Field label="To">
          <input
            className="input"
            type="date"
            value={reportTo}
            min={reportFrom}
            onChange={(event) => setReportTo(event.target.value)}
          />
        </Field>
        <button
          className="button button-ghost"
          disabled={busy}
          onClick={printIncomeExpense}
        >
          <ReceiptText size={15} />
          Print / PDF
        </button>
        <button
          className="button button-primary"
          disabled={busy}
          onClick={downloadIncomeExpense}
        >
          <Download size={15} />
          Download CSV
        </button>
      </div>
    </section>
  );
  return (
    <div className={`management-page management-${page}`}>
      {header}
      {(page === "reports" || page === "finance") && financialDownloads}
      {page === "settings" && <WorkspacePreferences />}
      {["overview","finance","reports"].includes(page)&&<ProfitSummary data={data}/>}
      {page === "overview" && (
        <>
          {stats}
          <div className="management-overview-grid">
            <section className="panel revenue-panel">
              <div className="management-card-heading">
                <div>
                  <h2>{"Revenue overview"}</h2>
                  <p>{"Every good day starts with a clear picture."}</p>
                </div>
                <span className="chart-series">
                  <i />
                  {"Revenue"}
                </span>
              </div>
              <div className="chart-total">
                {money(revenue)}
                <span>{"total sales"}</span>
              </div>
              {salesChart}
            </section>
            {paymentCard}
            <section className="panel popular-panel">
              <div className="management-card-heading">
                <div>
                  <h2>{"Guest favourites"}</h2>
                  <p>{"The dishes keeping your kitchen busy"}</p>
                </div>
                <Flame size={19} />
              </div>
              {topItems.length ? (
                <div className="top-items-list">
                  {topItems.slice(0, 5).map((item, index) => (
                    <div className="top-item" key={item.name}>
                      <span className="item-rank">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <div className="top-item-image">
                        {item.image ? (
                          <ProductPhoto src={item.image} alt="" />
                        ) : (
                          <Coffee size={22} />
                        )}
                      </div>
                      <div className="top-item-name">
                        <strong>{label(item)}</strong>
                        <span>
                          {number(item.count)} {"portions sold"}
                        </span>
                      </div>
                      <div className="top-item-value">
                        <strong>{money(item.revenue)}</strong>
                        <div>
                          <i
                            style={{
                              width: `${(item.revenue / (topItems[0]?.revenue || 1)) * 100}%`,
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty
                  title={"Your bestsellers will appear here"}
                  subtitle={"Complete your first sale to get started."}
                />
              )}
            </section>
            <section className="panel operations-panel">
              <div className="management-card-heading">
                <div>
                  <h2>{"On the floor"}</h2>
                  <p>{"A pulse on your restaurant"}</p>
                </div>
                <span className="management-pill green">
                  <span className="live-dot" />
                  {"Live"}
                </span>
              </div>
              <div className="operation-stat">
                <span className="operation-icon">
                  <ShoppingBag size={19} />
                </span>
                <div>
                  <span>{"Active orders"}</span>
                  <strong>
                    {
                      orders.filter(
                        (order) =>
                          !["completed", "cancelled"].includes(order.status),
                      ).length
                    }
                  </strong>
                </div>
                <ArrowUpRight size={18} />
              </div>
              <div className="operation-stat">
                <span className="operation-icon blue">
                  <Users size={19} />
                </span>
                <div>
                  <span>{"Tables occupied"}</span>
                  <strong>
                    {
                      data.tables.filter(
                        (table) =>
                          table.branchId === branchId &&
                          table.status === "occupied",
                      ).length
                    }
                    <small>
                      {" "}
                      /{" "}
                      {
                        data.tables.filter(
                          (table) => table.branchId === branchId,
                        ).length
                      }
                    </small>
                  </strong>
                </div>
              </div>
              <div className="operation-stat">
                <span className="operation-icon amber">
                  <Package size={19} />
                </span>
                <div>
                  <span>{"Low-stock ingredients"}</span>
                  <strong>{lowStock.length}</strong>
                </div>
                <Pill tone={lowStock.length ? "amber" : "green"}>
                  {lowStock.length ? "Check stock" : "Healthy"}
                </Pill>
              </div>
              <div className="overview-sync">
                <ShieldCheck size={18} />
                <div>
                  <strong>{"Your data stays with you"}</strong>
                  <span>
                    {data.sync.pending
                      ? `${data.sync.pending} ${"changes waiting to sync"}`
                      : "All changes saved to the branch hub"}
                  </span>
                </div>
              </div>
            </section>
          </div>
        </>
      )}

      {page === "inventory" && (
        <>
          <div className="management-stats three">
            <Stat
              label={"Inventory value"}
              amount={money(Math.round(stockValue))}
              note={"At recorded purchase cost"}
              icon={<Package size={18} />}
              accent
            />
            <Stat
              label={"Items tracked"}
              amount={number(inventory.length)}
              note={"Across all stock categories"}
              icon={<Layers3 size={18} />}
            />
            <Stat
              label={"Need attention"}
              amount={number(lowStock.length)}
              note={"At or below reorder level"}
              icon={<Activity size={18} />}
            />
          </div>
          <section className="panel management-table-panel">
            <div className="management-table-toolbar">
              <div className="management-tabs">
                {[
                  ["all", "All items", ""],
                  ["ingredient", "Ingredients", ""],
                  ["prepared", "Prepared", ""],
                  ["packaging", "Packaging", ""],
                  ["low", "Low stock", ""],
                ].map(([id, en, si]) => (
                  <button
                    key={id}
                    className={category === id ? "active" : ""}
                    onClick={() => setCategory(id)}
                  >
                    {en}
                    {id === "low" && <span>{lowStock.length}</span>}
                  </button>
                ))}
              </div>
              <SearchField
                value={search}
                onChange={setSearch}
                placeholder={"Find an item…"}
              />
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{"Item"}</th>
                    <th>{"Category"}</th>
                    <th>{"In stock"}</th>
                    <th>{"Reorder level"}</th>
                    <th>{"Unit cost"}</th>
                    <th>{"Status"}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {visibleInventory.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <div className="table-item">
                          <span className={`table-item-icon ${item.category}`}>
                            <Package size={17} />
                          </span>
                          <div>
                            <strong>{label(item)}</strong>
                            <small>{item.id.slice(0, 14).toUpperCase()}</small>
                          </div>
                        </div>
                      </td>
                      <td>
                        {item.category === "ingredient"
                          ? "Ingredient"
                          : item.category === "prepared"
                            ? "Prepared food"
                            : item.category === "packaging"
                              ? "Packaging"
                              : "Resale"}
                      </td>
                      <td>
                        <strong
                          className={
                            item.quantity <= item.minimum ? "text-amber" : ""
                          }
                        >
                          {number(item.quantity)}
                        </strong>{" "}
                        <span className="muted">{item.unit}</span>
                      </td>
                      <td>
                        {number(item.minimum)}{" "}
                        <span className="muted">{item.unit}</span>
                      </td>
                      <td>{money(item.unitCost)}</td>
                      <td>
                        <Pill
                          tone={
                            item.quantity <= 0
                              ? "red"
                              : item.quantity <= item.minimum
                                ? "amber"
                                : "green"
                          }
                        >
                          {item.quantity <= 0
                            ? "Out of stock"
                            : item.quantity <= item.minimum
                              ? "Running low"
                              : "In stock"}
                        </Pill>
                      </td>
                      <td>
                        <button
                          className="button button-ghost button-small"
                          onClick={() => {
                            setSelectedItem(item);
                            open("stock");
                          }}
                        >
                          <SlidersHorizontal size={14} />
                          {"Adjust"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!visibleInventory.length && (
                <Empty title={"No matching stock items"} />
              )}
            </div>
            <div className="management-table-footer">
              <span>
                {visibleInventory.length} {"items"}
              </span>
              <span>
                <ShieldCheck size={13} />
                {"All adjustments are audited"}
              </span>
            </div>
          </section>
          <section className="panel movement-panel">
            <div className="management-card-heading">
              <div>
                <h2>{"Stock activity"}</h2>
                <p>{"A complete trail of your latest stock movements"}</p>
              </div>
              <Activity size={18} />
            </div>
            <div className="movement-list">
              {data.stockMovements
                .filter((movement) => movement.branchId === branchId)
                .slice(0, 8)
                .map((movement) => (
                  <div key={movement.id}>
                    <span
                      className={`movement-icon ${movement.quantity >= 0 ? "positive" : "negative"}`}
                    >
                      {movement.quantity >= 0 ? (
                        <ArrowDownLeft size={17} />
                      ) : (
                        <ArrowUpRight size={17} />
                      )}
                    </span>
                    <div>
                      <strong>
                        {label(
                          inventory.find(
                            (item) => item.id === movement.itemId,
                          ) || { name: movement.itemId },
                        )}
                      </strong>
                      <span>{movement.reason}</span>
                    </div>
                    <strong
                      className={
                        movement.quantity >= 0 ? "text-mint" : "text-amber"
                      }
                    >
                      {movement.quantity >= 0 ? "+" : ""}
                      {number(movement.quantity)}
                    </strong>
                    <time>{dateTime(movement.createdAt)}</time>
                  </div>
                ))}
              {!data.stockMovements.some(
                (movement) => movement.branchId === branchId,
              ) && <Empty title={"Stock movements appear here"} />}
            </div>
          </section>
        </>
      )}

      {page === "production" && (
        <>
          <div className="management-stats three">
            <Stat
              label={"Batches prepared"}
              amount={number(
                data.production.filter(
                  (batch) =>
                    batch.branchId === branchId &&
                    isWithin(batch.createdAt, range, data.serverTime),
                ).length,
              )}
              note={"In the selected period"}
              icon={<Flame size={18} />}
              accent
            />
            <Stat
              label={"Portions produced"}
              amount={number(
                data.production
                  .filter(
                    (batch) =>
                      batch.branchId === branchId &&
                      isWithin(batch.createdAt, range, data.serverTime),
                  )
                  .reduce((sum, batch) => sum + batch.quantity, 0),
              )}
              note={"Prepared and added to stock"}
              icon={<Coffee size={18} />}
            />
            <Stat
              label={"Available to prepare"}
              amount={number(preparedMenu.length)}
              note={"Prepared-stock menu items"}
              icon={<BookOpen size={18} />}
            />
          </div>
          <div className="production-intro panel">
            <span className="production-intro-icon">
              <Flame size={26} />
            </span>
            <div>
              <h2>{"A better-prepared kitchen."}</h2>
              <p>
                {
                  "Record a production batch to add prepared portions to stock. Recipe ingredients are deducted automatically."
                }
              </p>
            </div>
            <span className="management-pill green">
              <Check size={13} />
              {"Stock connected"}
            </span>
          </div>
          <section className="panel management-table-panel">
            <div className="management-table-toolbar">
              <h2>{"Production history"}</h2>
              <SearchField
                value={search}
                onChange={setSearch}
                placeholder={"Find a batch…"}
              />
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{"Prepared item"}</th>
                    <th>{"Batch reference"}</th>
                    <th>{"Quantity"}</th>
                    <th>{"Batch cost"}</th>
                    <th>{"Note"}</th>
                    <th>{"Prepared at"}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.production
                    .filter(
                      (batch) =>
                        batch.branchId === branchId &&
                        isWithin(batch.createdAt, range, data.serverTime) &&
                        batch.name.toLowerCase().includes(search.toLowerCase()),
                    )
                    .map((batch) => (
                      <tr key={batch.id}>
                        <td>
                          <div className="table-item">
                            <span className="table-item-icon prepared">
                              <Flame size={17} />
                            </span>
                            <strong>
                              {label(
                                data.menu.find(
                                  (item) => item.id === batch.menuItemId,
                                ) || { name: batch.name },
                              )}
                            </strong>
                          </div>
                        </td>
                        <td>
                          <span className="mono muted">
                            {batch.id.slice(-8).toUpperCase()}
                          </span>
                        </td>
                        <td>
                          <strong>{number(batch.quantity)}</strong>{" "}
                          <span className="muted">{"portions"}</span>
                        </td>
                        <td>{money(batch.cost)}</td>
                        <td className="muted">{batch.note || "—"}</td>
                        <td className="muted">{dateTime(batch.createdAt)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {!data.production.some(
                (batch) =>
                  batch.branchId === branchId &&
                  isWithin(batch.createdAt, range, data.serverTime) &&
                  batch.name.toLowerCase().includes(search.toLowerCase()),
              ) && (
                <Empty
                  title={"No production recorded"}
                  subtitle={
                    "Start a new batch to keep prepared stock accurate."
                  }
                />
              )}
            </div>
          </section>
        </>
      )}

      {page === "purchases" && (
        <>
          <div className="management-stats three">
            <Stat
              label={"Purchases"}
              amount={money(
                data.purchases
                  .filter(
                    (purchase) =>
                      purchase.branchId === branchId &&
                      isWithin(purchase.createdAt, range, data.serverTime),
                  )
                  .reduce((sum, purchase) => sum + purchase.total, 0),
              )}
              note={"In the selected period"}
              icon={<Truck size={18} />}
              accent
            />
            <Stat
              label={"Active suppliers"}
              amount={number(data.suppliers.length)}
              note={"Trusted supply partners"}
              icon={<Users size={18} />}
            />
            <Stat
              label={"Supplier balances"}
              amount={money(
                data.suppliers.reduce(
                  (sum, supplier) => sum + supplier.balance,
                  0,
                ),
              )}
              note={"Outstanding supplier credit"}
              icon={<Wallet size={18} />}
            />
          </div>
          <section className="panel management-table-panel">
            <div className="management-table-toolbar">
              <h2>{"Purchase register"}</h2>
              <SearchField
                value={search}
                onChange={setSearch}
                placeholder={"Invoice or supplier…"}
              />
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{"Invoice"}</th>
                    <th>{"Supplier"}</th>
                    <th>{"Items"}</th>
                    <th>{"Total"}</th>
                    <th>{"Status"}</th>
                    <th>{"Received at"}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.purchases
                    .filter(
                      (purchase) =>
                        purchase.branchId === branchId &&
                        isWithin(purchase.createdAt, range, data.serverTime) &&
                        `${purchase.invoiceNumber} ${purchase.supplierName}`
                          .toLowerCase()
                          .includes(search.toLowerCase()),
                    )
                    .map((purchase) => (
                      <tr key={purchase.id}>
                        <td>
                          <div className="table-item">
                            <span className="table-item-icon blue">
                              <ReceiptText size={17} />
                            </span>
                            <strong>
                              {purchase.invoiceNumber ||
                                purchase.id.slice(-8).toUpperCase()}
                            </strong>
                          </div>
                        </td>
                        <td>{purchase.supplierName}</td>
                        <td>
                          <details className="purchase-details">
                            <summary>
                              {purchase.lines.length} {"items"}
                              <ChevronDown size={12} />
                            </summary>
                            <div>
                              {purchase.lines.map((line, index) => (
                                <span key={index}>
                                  {line.name} · {number(line.quantity)} ×{" "}
                                  {money(line.unitCost)}
                                </span>
                              ))}
                            </div>
                          </details>
                        </td>
                        <td>
                          <strong>{money(purchase.total)}</strong>
                        </td>
                        <td>
                          <Pill tone="green">
                            <Check size={12} />
                            {"Received"}
                          </Pill>
                        </td>
                        <td className="muted">
                          {dateTime(purchase.createdAt)}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {!data.purchases.some(
                (purchase) =>
                  purchase.branchId === branchId &&
                  isWithin(purchase.createdAt, range, data.serverTime) &&
                  `${purchase.invoiceNumber} ${purchase.supplierName}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
              ) && <Empty title={"No purchases found"} />}
            </div>
          </section>
          <section className="suppliers-section">
            <div className="section-heading">
              <h2>{"Your supply partners"}</h2>
              <span>
                {data.suppliers.length} {"suppliers"}
              </span>
            </div>
            <div className="supplier-grid">
              {data.suppliers.map((supplier, index) => (
                <article className="panel supplier-card" key={supplier.id}>
                  <span className={`supplier-avatar color-${index % 4}`}>
                    <Truck size={21} />
                  </span>
                  <h3>{supplier.name}</h3>
                  <p>{supplier.phone || "No phone provided"}</p>
                  <div>
                    <span>{"Outstanding balance"}</span>
                    <strong>{money(supplier.balance)}</strong>
                  </div>
                  {supplier.email && (
                    <a href={`mailto:${supplier.email}`}>
                      {supplier.email}
                      <ArrowUpRight size={13} />
                    </a>
                  )}
                </article>
              ))}
            </div>
          </section>
        </>
      )}

      {page === "customers" && customerView}

      {page === "team" && (
        <>
          <div className="management-stats three">
            <Stat
              label={"Team members"}
              amount={number(
                data.staff.filter(
                  (member) => !member.branchId || member.branchId === branchId,
                ).length,
              )}
              note={"Assigned to this branch"}
              icon={<Users size={18} />}
              accent
            />
            <Stat
              label={"Active access"}
              amount={number(
                data.staff.filter(
                  (member) =>
                    member.active &&
                    (!member.branchId || member.branchId === branchId),
                ).length,
              )}
              note={"Members who can sign in"}
              icon={<ShieldCheck size={18} />}
            />
            <Stat
              label={"Access roles"}
              amount="7"
              note={"Permissions for every responsibility"}
              icon={<Layers3 size={18} />}
            />
          </div>
          <section className="panel management-table-panel">
            <div className="management-table-toolbar">
              <h2>{"People & permissions"}</h2>
              <SearchField
                value={search}
                onChange={setSearch}
                placeholder={"Find a team member…"}
              />
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{"Team member"}</th>
                    <th>{"Role"}</th>
                    <th>{"Branch"}</th>
                    <th>{"Last active"}</th>
                    <th>{"Status"}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.staff
                    .filter(
                      (member) =>
                        (!member.branchId || member.branchId === branchId) &&
                        `${member.name} ${member.role}`
                          .toLowerCase()
                          .includes(search.toLowerCase()),
                    )
                    .map((member, index) => (
                      <tr key={member.id}>
                        <td>
                          <div className="table-item">
                            <span className={`guest-avatar color-${index % 4}`}>
                              {member.initials}
                            </span>
                            <div>
                              <strong>{member.name}</strong>
                              <small>{member.phone || "Team member"}</small>
                            </div>
                          </div>
                        </td>
                        <td>
                          <span className="role-label">{member.role}</span>
                        </td>
                        <td>
                          {member.branchId
                            ? label(
                                data.branches.find(
                                  (branch) => branch.id === member.branchId,
                                ) || { name: member.branchId },
                              )
                            : "All branches"}
                        </td>
                        <td className="muted">
                          {member.lastActive
                            ? dateTime(member.lastActive)
                            : "Not yet signed in"}
                        </td>
                        <td>
                          <Pill tone={member.active ? "green" : ""}>
                            {member.active ? "Active" : "Disabled"}
                          </Pill>
                        </td>
                        <td>
                          {member.id !== data.user.id && (
                            <button
                              className={`button button-ghost button-small ${member.active ? "text-amber" : ""}`}
                              disabled={busy}
                              onClick={() =>
                                run(
                                  () =>
                                    mutate(
                                      `/staff/${member.id}`,
                                      { active: !member.active },
                                      "PATCH",
                                    ),
                                  "Team access updated",
                                )
                              }
                            >
                              {member.active
                                ? "Disable access"
                                : "Enable access"}
                            </button>
                          )}
                          {member.id === data.user.id && (
                            <span className="muted">{"You"}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {!data.staff.some(
                (member) =>
                  (!member.branchId || member.branchId === branchId) &&
                  `${member.name} ${member.role}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
              ) && <Empty title={"No matching team members"} />}
            </div>
            <div className="management-table-footer">
              <span>
                <ShieldCheck size={14} />
                {
                  "Every sign-in and sensitive action is recorded in the audit trail."
                }
              </span>
            </div>
          </section>
        </>
      )}

      {page === "finance" && (
        <>
          <div className="management-stats">
            <Stat
              label={"Sales revenue"}
              amount={money(revenue)}
              note={"Settled orders in this period"}
              icon={<TrendingUp size={18} />}
              accent
            />
            <Stat
              label={"Operating expenses"}
              amount={money(expenseTotal)}
              note={`${expenses.length} ${"recorded expenses"}`}
              icon={<ArrowUpRight size={18} />}
            />
            <Stat
              label={"Revenue less expenses"}
              amount={money(revenue - expenseTotal)}
              note={"Before food costs & other adjustments"}
              icon={<CircleDollarSign size={18} />}
            />
            <Stat
              label={"Expected drawer cash"}
              amount={money(activeShift?.expectedCash || 0)}
              note={
                activeShift
                  ? "For the current open shift"
                  : "No shift is currently open"
              }
              icon={<Banknote size={18} />}
            />
          </div>
          <section
            className={`panel cash-shift-banner ${activeShift ? "shift-is-open" : ""}`}
          >
            <div className="cash-shift-icon">
              <Wallet size={24} />
            </div>
            <div>
              <h2>
                {activeShift
                  ? "Your cash shift is open"
                  : "Start with a balanced drawer"}
              </h2>
              <p>
                {activeShift
                  ? `${"Opened"} ${dateTime(activeShift.openedAt)} · ${"Opening float"} ${money(activeShift.openingFloat)}`
                  : "Open a shift to track cash sales, expenses and your closing balance."}
              </p>
            </div>
            <button
              className="button button-primary"
              onClick={() => {
                setSelectedShift(activeShift || null);
                open(activeShift ? "shift-close" : "shift-open");
              }}
            >
              {activeShift ? "Close & reconcile" : "Open cash shift"}
              <ArrowRight size={16} />
            </button>
          </section>
          <section className="panel management-table-panel">
            <div className="management-table-toolbar">
              <h2>{"Expense ledger"}</h2>
              <SearchField
                value={search}
                onChange={setSearch}
                placeholder={"Search expenses…"}
              />
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{"Expense"}</th>
                    <th>{"Category"}</th>
                    <th>{"Paid by"}</th>
                    <th>{"Amount"}</th>
                    <th>{"Date & time"}</th>
                  </tr>
                </thead>
                <tbody>
                  {expenses
                    .filter((expense) =>
                      `${expense.description} ${expense.category}`
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    )
                    .map((expense) => (
                      <tr key={expense.id}>
                        <td>
                          <div className="table-item">
                            <span className="table-item-icon amber">
                              <ArrowUpRight size={17} />
                            </span>
                            <strong>{expense.description}</strong>
                          </div>
                        </td>
                        <td>
                          <span className="role-label">{expense.category}</span>
                        </td>
                        <td>
                          <span className="role-label">
                            {expense.paymentMethod}
                          </span>
                        </td>
                        <td>
                          <strong>{money(expense.amount)}</strong>
                        </td>
                        <td className="muted">{dateTime(expense.createdAt)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {!expenses.some((expense) =>
                `${expense.description} ${expense.category}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              ) && (
                <Empty
                  title={"No expenses recorded"}
                  subtitle={
                    "Keep business expenses here for an accurate daily picture."
                  }
                />
              )}
            </div>
          </section>
          <section className="panel management-table-panel">
            <div className="management-card-heading">
              <div>
                <h2>{"Cash shift history"}</h2>
                <p>{"A clear reconciliation for every shift"}</p>
              </div>
              <Clock3 size={18} />
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{"Opened"}</th>
                    <th>{"Opening float"}</th>
                    <th>{"Expected"}</th>
                    <th>{"Counted"}</th>
                    <th>{"Variance"}</th>
                    <th>{"Status"}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.shifts
                    .filter((shift) => shift.branchId === branchId)
                    .map((shift) => (
                      <tr key={shift.id}>
                        <td className="muted">{dateTime(shift.openedAt)}</td>
                        <td>{money(shift.openingFloat)}</td>
                        <td>{money(shift.expectedCash)}</td>
                        <td>
                          {shift.countedCash !== null
                            ? money(shift.countedCash)
                            : "—"}
                        </td>
                        <td
                          className={
                            shift.variance ? "text-amber" : "text-mint"
                          }
                        >
                          {shift.variance !== null
                            ? money(shift.variance)
                            : "—"}
                        </td>
                        <td>
                          <Pill tone={shift.status === "open" ? "green" : ""}>
                            {shift.status === "open" ? "Open" : "Closed"}
                          </Pill>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {!data.shifts.some((shift) => shift.branchId === branchId) && (
                <Empty title={"No shifts yet"} />
              )}
            </div>
          </section>
        </>
      )}

      {page === "reports" && (
        <>
          {stats}
          <div className="management-reports-grid">
            <section className="panel revenue-panel">
              <div className="management-card-heading">
                <div>
                  <h2>{"Sales performance"}</h2>
                  <p>{"Revenue from settled orders"}</p>
                </div>
                <TrendingUp size={18} />
              </div>
              <div className="chart-total">{money(revenue)}</div>
              {salesChart}
            </section>
            {paymentCard}
          </div>
          <section className="panel management-table-panel">
            <div className="management-table-toolbar">
              <h2>{"Item performance"}</h2>
              <button
                className="button button-ghost button-small"
                onClick={() =>
                  downloadCSV(
                    `demo-hotel-items-${dayKey(data.serverTime)}.csv`,
                    [
                      ["Item", "Quantity sold", "Gross sales (LKR)"],
                      ...topItems.map((item) => [
                        item.name,
                        item.count,
                        item.revenue / 100,
                      ]),
                    ],
                  )
                }
              >
                <Download size={14} />
                {"Export items"}
              </button>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{"Menu item"}</th>
                    <th>{"Portions sold"}</th>
                    <th>{"Gross item sales"}</th>
                    <th>{"Sales share"}</th>
                  </tr>
                </thead>
                <tbody>
                  {topItems.map((item) => (
                    <tr key={item.name}>
                      <td>
                        <strong>{label(item)}</strong>
                      </td>
                      <td>{number(item.count)}</td>
                      <td>{money(item.revenue)}</td>
                      <td>
                        <div className="sales-share">
                          <div>
                            <i
                              style={{
                                width: `${(item.revenue / (topItems.reduce((sum, item) => sum + item.revenue, 0) || 1)) * 100}%`,
                              }}
                            />
                          </div>
                          <span>
                            {Math.round(
                              (item.revenue /
                                (topItems.reduce(
                                  (sum, item) => sum + item.revenue,
                                  0,
                                ) || 1)) *
                                100,
                            )}
                            %
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!topItems.length && <Empty title={"No sales in this period"} />}
            </div>
          </section>
          <section className="panel management-table-panel">
            <div className="management-card-heading">
              <div>
                <h2>{"Audit trail"}</h2>
                <p>{"Business-critical activity, securely recorded"}</p>
              </div>
              <ShieldCheck size={18} />
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{"Activity"}</th>
                    <th>{"Detail"}</th>
                    <th>{"By"}</th>
                    <th>{"Date & time"}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.audit
                    .filter(
                      (event) =>
                        (!event.branchId || event.branchId === branchId) &&
                        isWithin(event.createdAt, range, data.serverTime),
                    )
                    .slice(0, 30)
                    .map((event) => (
                      <tr key={event.id}>
                        <td>
                          <Pill>{event.action.replaceAll("_", " ")}</Pill>
                        </td>
                        <td>{event.detail}</td>
                        <td>
                          {data.staff.find(
                            (member) => member.id === event.actor,
                          )?.name || event.actor}
                        </td>
                        <td className="muted">{dateTime(event.createdAt)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {!data.audit.some(
                (event) =>
                  (!event.branchId || event.branchId === branchId) &&
                  isWithin(event.createdAt, range, data.serverTime),
              ) && <Empty title={"No activity in this period"} />}
            </div>
          </section>
        </>
      )}

      {page === "settings" && (
        <div className="settings-layout">
          <div className="settings-main">
            <form
              className="panel settings-card"
              onSubmit={(event) =>
                submit(
                  event,
                  () =>
                    mutate("/settings", { ...settings, language: "en" }, "PUT"),
                  "Business settings saved",
                )
              }
            >
              <div className="management-card-heading">
                <div>
                  <h2>{"Business profile"}</h2>
                  <p>
                    {
                      "The details that appear across your workspace and receipts"
                    }
                  </p>
                </div>
                <ShoppingBag size={18} />
              </div>
              <div className="form-grid">
                <Field label={"Business name"}>
                  <input
                    className="input"
                    required
                    maxLength={100}
                    value={settings.businessName}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        businessName: event.target.value,
                      })
                    }
                  />
                </Field>
                <Field label={"Tagline"}>
                  <input
                    className="input"
                    maxLength={160}
                    value={settings.tagline}
                    onChange={(event) =>
                      setSettings({ ...settings, tagline: event.target.value })
                    }
                  />
                </Field>
                <Field label={"Tax rate (%)"}>
                  <input
                    className="input"
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    required
                    value={settings.taxRate}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        taxRate: Number(event.target.value),
                      })
                    }
                  />
                </Field>
                <Field label={"Service charge (%)"}>
                  <input
                    className="input"
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    required
                    value={settings.serviceChargeRate}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        serviceChargeRate: Number(event.target.value),
                      })
                    }
                  />
                </Field>
                <Field label={"Default language"}>
                  <select className="select" value="en" disabled>
                    <option value="en">English</option>
                  </select>
                </Field>
                <Field label={"Currency"}>
                  <input className="input" value={settings.currency} disabled />
                  <small className="field-hint">
                    {"Sri Lankan rupees · LKR"}
                  </small>
                </Field>
                <Field label={"Receipt footer"} full>
                  <textarea
                    className="input"
                    rows={3}
                    maxLength={300}
                    value={settings.receiptFooter}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        receiptFooter: event.target.value,
                      })
                    }
                  />
                </Field>
              </div>
              <div className="settings-switches">
                <label>
                  <span>
                    <strong>{"Low stock alerts"}</strong>
                    <small>
                      {"Highlight ingredients that reach their reorder level"}
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={settings.lowStockAlerts}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        lowStockAlerts: event.target.checked,
                      })
                    }
                  />
                </label>
                <label>
                  <span>
                    <strong>{"Print after payment"}</strong>
                    <small>
                      {
                        "Open the receipt print dialog after a successful payment"
                      }
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={settings.autoPrint}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        autoPrint: event.target.checked,
                      })
                    }
                  />
                </label>
              </div>
              <div className="settings-form-error form-error" role="alert">
                {error}
              </div>
              <div className="form-actions">
                <button
                  className="button button-primary"
                  disabled={busy}
                  type="submit"
                >
                  <Check size={16} />
                  {busy ? "Saving…" : "Save changes"}
                </button>
              </div>
            </form>
            <section className="panel settings-card">
              <div className="management-card-heading">
                <div>
                  <h2>{"Branch locations"}</h2>
                  <p>{"Connected locations in your restaurant network"}</p>
                </div>
                <Layers3 size={18} />
              </div>
              <div className="settings-branches">
                {data.branches.map((branch) => (
                  <div key={branch.id}>
                    <span className="branch-code">{branch.code}</span>
                    <div>
                      <strong>{label(branch)}</strong>
                      <span>{branch.address}</span>
                      <small>{branch.phone}</small>
                    </div>
                    {branch.id === branchId && (
                      <Pill tone="green">{"Current"}</Pill>
                    )}
                  </div>
                ))}
              </div>
            </section>
          </div>
          <aside className="settings-aside">
            <section className="panel settings-sync">
              <div className="settings-sync-symbol">
                <ShieldCheck size={28} />
                <span />
              </div>
              <Pill tone="green">{"Local-first"}</Pill>
              <h2>{"Built to keep going."}</h2>
              <p>
                {
                  "Sales are saved securely to your branch hub. Cloud sync keeps a second copy when the internet is available."
                }
              </p>
              <div className="sync-status-list">
                <div>
                  <span>{"Branch hub"}</span>
                  <Pill tone={data.sync.hubOnline ? "green" : "amber"}>
                    {data.sync.hubOnline ? "Connected" : "Disconnected"}
                  </Pill>
                </div>
                <div>
                  <span>Firebase</span>
                  <Pill tone={data.sync.configured ? "green" : "amber"}>
                    {data.sync.configured ? "Configured" : "Not configured"}
                  </Pill>
                </div>
                <div>
                  <span>{"Pending changes"}</span>
                  <strong>{data.sync.pending}</strong>
                </div>
                <div>
                  <span>{"Synced records"}</span>
                  <strong>{number(data.sync.synced)}</strong>
                </div>
                <div>
                  <span>{"Last synced"}</span>
                  <small>
                    {data.sync.lastSync
                      ? dateTime(data.sync.lastSync)
                      : "Not yet"}
                  </small>
                </div>
              </div>
              {data.sync.lastError && (
                <div className="inline-warning">{data.sync.lastError}</div>
              )}
              <button
                className="button button-ghost full-width"
                disabled={busy || !data.sync.configured}
                onClick={() =>
                  run(() => mutate("/sync", {}), "Cloud sync requested")
                }
              >
                <Cloud size={16} />
                {"Sync now"}
              </button>
              {!data.sync.configured && (
                <p className="settings-small-note">
                  {
                    "Cloud sync is not connected. An administrator can configure it securely on the server."
                  }
                </p>
              )}
            </section>
            {!isDeviceWorkspace() && <section className="panel settings-backup">
              <div className="management-card-heading">
                <div>
                  <h2>{"Database backup"}</h2>
                  <p>{"An independent copy for safekeeping"}</p>
                </div>
                <Download size={18} />
              </div>
              <p>
                {
                  "Download a consistent backup of the branch database. Keep it in a secure location."
                }
              </p>
              <div className="backup-last">
                <Clock3 size={14} />
                {data.sync.lastBackup
                  ? dateTime(data.sync.lastBackup)
                  : "No backup created yet"}
              </div>
              <button
                className="button button-ghost full-width"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const result = await mutate<{
                      filename: string;
                    }>("/backups", {});
                    const link = document.createElement("a");
                    link.href = `/api/backups/${encodeURIComponent(result.filename)}`;
                    link.download = result.filename;
                    link.click();
                  }, "Backup created")
                }
              >
                <ArrowDownToLine size={16} />
                {"Create & download backup"}
              </button>
            </section>}
          </aside>
        </div>
      )}

      {(page === "settings" || page === "production") && menuCatalog}
      {dialog && (
        <Modal
          title={
            dialog === "customer-ledger"
              ? "Customer ledger & collection"
              : dialog === "inventory-create"
                ? "Add inventory item"
                : dialog === "supplier"
                  ? "Add supplier"
                  : dialog === "menu"
                    ? editingMenu
                      ? "Edit menu item"
                      : "Add menu item"
                    : dialog === "recipe"
                      ? `Recipe · ${editingMenu?.name || ""}`
                      : dialog === "stock"
                        ? "Adjust inventory"
                        : dialog === "production"
                          ? "New production batch"
                          : dialog === "purchase"
                            ? "Record a purchase"
                            : dialog === "customer"
                              ? "Add a guest"
                              : dialog === "staff"
                                ? "Invite a team member"
                                : dialog === "expense"
                                  ? "Record an expense"
                                  : dialog === "shift-open"
                                    ? "Open a cash shift"
                                    : "Close & reconcile shift"
          }
          subtitle={"Changes are saved to your branch hub."}
          close={close}
        >
          {dialog === "inventory-create" && (
            <form
              onSubmit={(event) =>
                submit(
                  event,
                  (fields) =>
                    mutate("/inventory", {
                      commandId: formCommandId,
                      branchId,
                      name: value(fields, "name"),
                      category: stockCategory,
                      unit: value(fields, "unit"),
                      quantity: Number(fields.get("quantity")),
                      minimum: Number(fields.get("minimum")),
                      unitCost: minor(fields.get("unitCost")),
                      supplierId: value(fields, "supplierId") || null,
                      menuItemId: value(fields, "menuItemId") || null,
                    }),
                  "Inventory item created",
                )
              }
            >
              <div className="form-grid">
                <Field label="Item name" full>
                  <input
                    className="input"
                    name="name"
                    required
                    minLength={2}
                    maxLength={120}
                    placeholder="e.g. Basmati rice"
                  />
                </Field>
                <Field label="Stock category">
                  <select
                    className="select"
                    required
                    value={stockCategory}
                    onChange={(event) =>
                      setStockCategory(
                        event.target.value as InventoryItem["category"],
                      )
                    }
                  >
                    <option value="ingredient">Ingredient</option>
                    <option value="prepared">Prepared food</option>
                    <option value="packaging">Packaging</option>
                    <option value="resale">Resale item</option>
                  </select>
                </Field>
                <Field label="Stock unit">
                  <select
                    className="select"
                    name="unit"
                    required
                    defaultValue="kg"
                  >
                    <option value="kg">Kilograms (kg)</option>
                    <option value="g">Grams (g)</option>
                    <option value="L">Litres (L)</option>
                    <option value="ml">Millilitres (ml)</option>
                    <option value="pcs">Pieces (pcs)</option>
                    <option value="portions">Portions</option>
                    <option value="packs">Packs</option>
                  </select>
                </Field>
                <Field label="Opening quantity">
                  <input
                    className="input"
                    name="quantity"
                    type="number"
                    step="0.001"
                    min="0"
                    max="100000"
                    required
                    defaultValue="0"
                  />
                </Field>
                <Field label="Reorder level">
                  <input
                    className="input"
                    name="minimum"
                    type="number"
                    step="0.001"
                    min="0"
                    max="100000"
                    required
                    defaultValue="0"
                  />
                </Field>
                <Field label="Cost per stock unit (LKR)">
                  <input
                    className="input"
                    name="unitCost"
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    placeholder="0.00"
                  />
                </Field>
                <Field label="Supplier (optional)">
                  <select className="select" name="supplierId" defaultValue="">
                    <option value="">Not assigned</option>
                    {data.suppliers.map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>
                        {supplier.name}
                      </option>
                    ))}
                  </select>
                </Field>
                {stockCategory === "prepared" && (
                  <Field label="Linked menu item" full>
                    <select
                      className="select"
                      name="menuItemId"
                      required
                      defaultValue=""
                    >
                      <option value="">Select a prepared menu item</option>
                      {data.menu
                        .filter(
                          (item) =>
                            item.stockMode === "prepared" &&
                            !inventory.some(
                              (stock) =>
                                stock.category === "prepared" &&
                                stock.menuItemId === item.id,
                            ),
                        )
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                    </select>
                    <small className="field-hint">
                      Create the dish in Settings → Menu & recipes first, then
                      link its prepared stock here.
                    </small>
                  </Field>
                )}
              </div>
              {footer("Create item")}
            </form>
          )}
          {dialog === "supplier" && (
            <form
              onSubmit={(event) =>
                submit(
                  event,
                  (fields) =>
                    mutate("/suppliers", {
                      name: value(fields, "name"),
                      phone: value(fields, "phone"),
                      email: value(fields, "email"),
                    }),
                  "Supplier created",
                )
              }
            >
              <div className="form-grid">
                <Field label="Supplier name" full>
                  <input
                    className="input"
                    name="name"
                    required
                    minLength={2}
                    maxLength={120}
                    placeholder="Company or supplier name"
                  />
                </Field>
                <Field label="Phone number">
                  <input
                    className="input"
                    name="phone"
                    type="tel"
                    required
                    maxLength={30}
                    placeholder="077 123 4567"
                  />
                </Field>
                <Field label="Email (optional)">
                  <input
                    className="input"
                    name="email"
                    type="email"
                    maxLength={160}
                    placeholder="orders@supplier.lk"
                  />
                </Field>
              </div>
              {footer("Add supplier")}
            </form>
          )}
          {dialog === "menu" && (
            <form
              onSubmit={(event) =>
                submit(
                  event,
                  (fields) =>
                    mutate(
                      editingMenu ? `/menu/${editingMenu.id}` : "/menu",
                      {
                        commandId: formCommandId,
                        name: value(fields, "name"),
                        description: value(fields, "description"),
                        categoryId: value(fields, "categoryId"),
                        price: minor(fields.get("price")),
                        cost: minor(fields.get("cost")),
                        image:menuPhoto || "/images/chicken-rice.jpg",
                        stockMode: menuStockMode,
                        available: fields.get("available") === "on",
                        preparationMinutes: Number(
                          fields.get("preparationMinutes"),
                        ),
                        badge: value(fields, "badge") || undefined,
                      },
                      editingMenu ? "PATCH" : "POST",
                    ),
                  editingMenu ? "Menu item updated" : "Menu item created",
                )
              }
            >
              <div className="form-grid">
                <Field label="Dish name" full>
                  <input
                    className="input"
                    name="name"
                    required
                    minLength={2}
                    maxLength={120}
                    defaultValue={editingMenu?.name || ""}
                  />
                </Field>
                <Field label="Category">
                  <select
                    className="select"
                    name="categoryId"
                    required
                    defaultValue={
                      editingMenu?.categoryId || data.categories[0]?.id
                    }
                  >
                    {data.categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Stock tracking">
                  <select
                    className="select"
                    value={menuStockMode}
                    onChange={(event) =>
                      setMenuStockMode(
                        event.target.value as MenuItem["stockMode"],
                      )
                    }
                  >
                    <option value="prepared">Prepared portions</option>
                    <option value="recipe">Ingredients per order</option>
                    <option value="untracked">No stock tracking</option>
                  </select>
                </Field>
                <Field label="Selling price (LKR)">
                  <input
                    className="input"
                    name="price"
                    type="number"
                    min="0.01"
                    step="0.01"
                    required
                    defaultValue={editingMenu ? editingMenu.price / 100 : ""}
                  />
                </Field>
                <Field label="Reference food cost (LKR)">
                  <input
                    className="input"
                    name="cost"
                    type="number"
                    min="0"
                    step="0.01"
                    required
                    defaultValue={editingMenu ? editingMenu.cost / 100 : "0"}
                  />
                </Field>
                <Field label="Preparation time (minutes)">
                  <input
                    className="input"
                    name="preparationMinutes"
                    type="number"
                    min="0"
                    max="180"
                    step="1"
                    required
                    defaultValue={editingMenu?.preparationMinutes ?? 10}
                  />
                </Field>
                <Field label="Badge (optional)">
                  <input
                    className="input"
                    name="badge"
                    maxLength={30}
                    defaultValue={editingMenu?.badge || ""}
                    placeholder="e.g. Popular"
                  />
                </Field>
                <PhotoPicker value={menuPhoto} onChange={setMenuPhoto} onBusyChange={setMenuPhotoBusy} disabled={busy}/>
                <Field label="Description" full>
                  <textarea
                    className="input"
                    name="description"
                    rows={2}
                    maxLength={500}
                    defaultValue={editingMenu?.description || ""}
                  />
                </Field>
                <label className="catalog-active-toggle">
                  <input
                    type="checkbox"
                    name="available"
                    defaultChecked={
                      (editingMenu as (MenuItem & { enabled?: boolean }) | null)
                        ?.enabled !== false
                    }
                  />
                  <span>Enable this item on the menu</span>
                </label>
                {menuStockMode !== "untracked" && (
                  <div className="form-info">
                    <BookOpen size={18} />
                    <span>
                      {menuStockMode === "prepared"
                        ? "After saving, link prepared stock in Inventory and configure the recipe. Production consumes ingredients and adds prepared portions."
                        : "After saving, configure the ingredients and quantities per portion. They will be deducted when an order is placed."}
                    </span>
                  </div>
                )}
              </div>
              {footer(editingMenu ? "Save menu item" : "Create menu item")}
            </form>
          )}
          {dialog === "recipe" && editingMenu && (
            <form
              onSubmit={(event) =>
                submit(
                  event,
                  () => {
                    const enteredLines = recipeLines.map((line) => ({
                      key: line.key,
                      quantity: Number(line.quantity),
                    }));
                    const batchYield = Number(recipeYield);
                    const lines = portionIngredients(enteredLines, batchYield);
                    if (
                      lines.some(
                        (line) =>
                          !line.key ||
                          !Number.isFinite(line.quantity) ||
                          line.quantity <= 0,
                      )
                    )
                      throw new Error(
                        "Select an ingredient and a positive quantity for every line.",
                      );
                    if (
                      new Set(lines.map((line) => line.key)).size !==
                      lines.length
                    )
                      throw new Error(
                        "Combine repeated ingredients into a single line.",
                      );
                    return mutate(
                      `/menu/${editingMenu.id}/recipe`,
                      { commandId: formCommandId, ingredients: lines, batchYield },
                      "PUT",
                    );
                  },
                  "Recipe saved",
                )
              }
            >
              <div className="form-info">
                <BookOpen size={18} />
                <span>
                  Enter the ingredients and packaging for your <strong>whole batch</strong>, then enter how many portions it makes.
                  Quantities use each stock unit. The app calculates the cost and stock usage per portion. This recipe applies across branches.
                </span>
              </div>
              <div className="form-grid">
                <Field label="Recipe yield (portions)" full>
                  <input className="input" aria-label="Recipe yield (portions)" type="number" min="1" max="100000" step="0.01" required value={recipeYield} onChange={event => setRecipeYield(event.target.value)} />
                </Field>
              </div>
              <div className="recipe-form-lines">
                {recipeLines.map((line, index) => {
                  const item = ingredients.find(
                    (item) => ingredientKey(item) === line.key,
                  );
                  return (
                    <div key={index}>
                      <Field label="Ingredient / packaging">
                        <select
                          className="select"
                          required
                          value={line.key}
                          onChange={(event) =>
                            setRecipeLines(
                              recipeLines.map((line, i) =>
                                i === index
                                  ? { ...line, key: event.target.value }
                                  : line,
                              ),
                            )
                          }
                        >
                          <option value="">Select ingredient or packaging</option>
                          {ingredients.map((item) => (
                            <option key={item.id} value={ingredientKey(item)}>
                              {item.name} ({item.unit})
                            </option>
                          ))}
                          {line.key && !item && (
                            <option value={line.key}>
                              {line.key} · unavailable in this branch
                            </option>
                          )}
                        </select>
                      </Field>
                      <Field label={`Batch quantity${item ? ` (${item.unit})` : ""}`}>
                        <input
                          className="input"
                          type="number"
                          min="0.0001"
                          max="100000"
                          step="0.0001"
                          required
                          value={line.quantity}
                          onChange={(event) =>
                            setRecipeLines(
                              recipeLines.map((line, i) =>
                                i === index
                                  ? { ...line, quantity: event.target.value }
                                  : line,
                              ),
                            )
                          }
                        />
                      </Field>
                      <button
                        className="icon-button"
                        type="button"
                        aria-label="Remove ingredient"
                        disabled={recipeLines.length === 1}
                        onClick={() =>
                          setRecipeLines(
                            recipeLines.filter((_, i) => i !== index),
                          )
                        }
                      >
                        <X size={16} />
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="purchase-form-bottom recipe-cost-preview">
                <button
                  className="button button-ghost button-small"
                  type="button"
                  onClick={() =>
                    setRecipeLines([...recipeLines, { key: "", quantity: "" }])
                  }
                >
                  <Plus size={14} />
                  Add ingredient / packaging
                </button>
                <span>
                  Total batch cost
                  <strong>
                    {money(recipeBatchCost)}
                  </strong>
                </span>
              </div>
              <div className="purchase-form-bottom">
                <span>Cost per portion<strong>{money(recipePortionCost)}</strong></span>
                <span>Selling price<strong>{money(editingMenu.price)}</strong></span>
                <span>Gross profit / portion<strong>{money(editingMenu.price - recipePortionCost)}</strong></span>
              </div>
              <p className="recipe-help">
                Example: 20 kg rice for 50 parcels = 0.4 kg per portion. Include oil, spices and containers as stock ingredients or packaging.
                Direct ingredient and packaging costs appear here; record wages, rent and utilities as expenses.
              </p>
              {footer("Save recipe")}
            </form>
          )}
          {dialog === "stock" && (
            <form
              onSubmit={(event) =>
                submit(
                  event,
                  (fields) => {
                    const quantity = Number(fields.get("quantity"));
                    if (!quantity)
                      throw new Error("Enter a non-zero adjustment.");
                    return mutate("/inventory/adjust", {
                      commandId: formCommandId,
                      branchId,
                      itemId: value(fields, "itemId"),
                      quantity,
                      reason: value(fields, "reason"),
                    });
                  },
                  "Stock adjustment recorded",
                )
              }
            >
              <div className="form-grid">
                <Field label={"Stock item"} full>
                  <select
                    className="select"
                    required
                    name="itemId"
                    defaultValue={selectedItem?.id || ""}
                    onChange={(event) =>
                      setSelectedItem(
                        inventory.find(
                          (item) => item.id === event.target.value,
                        ) || null,
                      )
                    }
                  >
                    <option value="">{"Select an item"}</option>
                    {inventory.map((item) => (
                      <option key={item.id} value={item.id}>
                        {label(item)} · {number(item.quantity)} {item.unit}
                      </option>
                    ))}
                  </select>
                </Field>
                {selectedItem && (
                  <div className="form-info">
                    <Package size={18} />
                    {"Current stock"}:{" "}
                    <strong>
                      {number(selectedItem.quantity)} {selectedItem.unit}
                    </strong>
                  </div>
                )}
                <Field label={"Quantity change (+ add / − remove)"} full>
                  <input
                    className="input"
                    type="number"
                    name="quantity"
                    step="0.001"
                    required
                    placeholder="e.g. 5 or -2"
                  />
                  <small className="field-hint">
                    {
                      "Enter the amount to add or remove, not the final stock balance."
                    }
                  </small>
                </Field>
                <Field label={"Reason"} full>
                  <textarea
                    className="input"
                    name="reason"
                    required
                    minLength={3}
                    maxLength={300}
                    rows={3}
                    placeholder={"Stock count correction, spoilage, waste…"}
                  />
                </Field>
              </div>
              {footer("Record adjustment")}
            </form>
          )}
          {dialog === "production" && (
            <form
              onSubmit={(event) =>
                submit(
                  event,
                  (fields) =>
                    mutate("/production", {
                      commandId: formCommandId,
                      branchId,
                      menuItemId: value(fields, "menuItemId"),
                      quantity: Number(fields.get("quantity")),
                      note: value(fields, "note"),
                    }),
                  "Production batch recorded",
                )
              }
            >
              <div className="form-grid">
                <Field label={"Prepared menu item"} full>
                  <select
                    className="select"
                    name="menuItemId"
                    required
                    value={productionMenuId}
                    onChange={(event) =>
                      setProductionMenuId(event.target.value)
                    }
                  >
                    <option value="">{"Select a dish"}</option>
                    {preparedMenu.map((item) => (
                      <option value={item.id} key={item.id}>
                        {label(item)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={"Portions prepared"} full>
                  <input
                    className="input"
                    name="quantity"
                    type="number"
                    min="1"
                    max="100000"
                    step="1"
                    required
                    value={productionQuantity}
                    onChange={(event) =>
                      setProductionQuantity(event.target.value)
                    }
                  />
                </Field>
                <div className="form-info">
                  <Flame size={18} />
                  <span>
                    {
                      "Prepared stock increases and recipe ingredients are deducted together, in one transaction."
                    }
                  </span>
                </div>
                <Field label={"Batch note (optional)"} full>
                  <textarea
                    className="input"
                    name="note"
                    maxLength={300}
                    rows={3}
                    placeholder={"Morning preparation, lunch service…"}
                  />
                </Field>
              </div>
              {!preparedMenu.length && (
                <div className="inline-warning">
                  {"No prepared-stock menu items are configured."}
                </div>
              )}
              {footer("Record production")}
            </form>
          )}
          {dialog === "purchase" && (
            <form
              onSubmit={(event) =>
                submit(
                  event,
                  (fields) => {
                    const lines = purchaseLines.map((line) => ({
                      itemId: line.itemId,
                      quantity: Number(line.quantity),
                      unitCost: Math.round(Number(line.unitCost) * 100),
                    }));
                    if (
                      lines.some(
                        (line) =>
                          !line.itemId ||
                          line.quantity <= 0 ||
                          line.unitCost < 0 ||
                          !Number.isFinite(line.unitCost),
                      )
                    )
                      throw new Error("Check each purchase line.");
                    return mutate("/purchases", {
                      commandId: formCommandId,
                      branchId,
                      supplierId: value(fields, "supplierId"),
                      invoiceNumber: value(fields, "invoiceNumber"),
                      lines,
                    });
                  },
                  "Purchase received and stock updated",
                )
              }
            >
              <div className="form-grid">
                <Field label={"Supplier"}>
                  <select
                    className="select"
                    name="supplierId"
                    required
                    defaultValue=""
                  >
                    <option value="">{"Select supplier"}</option>
                    {data.suppliers.map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>
                        {supplier.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={"Invoice number"}>
                  <input
                    className="input"
                    name="invoiceNumber"
                    required
                    maxLength={100}
                    placeholder="INV-0001"
                  />
                </Field>
              </div>
              <div className="purchase-line-heading">
                <h3>{"Received items"}</h3>
                <span>{"Prices in LKR"}</span>
              </div>
              <div className="purchase-form-lines">
                {purchaseLines.map((line, index) => (
                  <div key={index}>
                    <Field label={"Item"}>
                      <select
                        className="select"
                        required
                        value={line.itemId}
                        onChange={(event) => {
                          const selected = inventory.find(
                            (item) => item.id === event.target.value,
                          );
                          setPurchaseLines(
                            purchaseLines.map((line, i) =>
                              i === index
                                ? {
                                    ...line,
                                    itemId: event.target.value,
                                    unitCost: selected
                                      ? String(selected.unitCost / 100)
                                      : "",
                                  }
                                : line,
                            ),
                          );
                        }}
                      >
                        <option value="">{"Select item"}</option>
                        {inventory.map((item) => (
                          <option key={item.id} value={item.id}>
                            {label(item)} ({item.unit})
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={"Quantity"}>
                      <input
                        className="input"
                        type="number"
                        required
                        min="0.001"
                        step="0.001"
                        value={line.quantity}
                        onChange={(event) =>
                          setPurchaseLines(
                            purchaseLines.map((line, i) =>
                              i === index
                                ? { ...line, quantity: event.target.value }
                                : line,
                            ),
                          )
                        }
                      />
                    </Field>
                    <Field label={"Unit price"}>
                      <input
                        className="input"
                        type="number"
                        required
                        min="0"
                        step="0.01"
                        value={line.unitCost}
                        onChange={(event) =>
                          setPurchaseLines(
                            purchaseLines.map((line, i) =>
                              i === index
                                ? { ...line, unitCost: event.target.value }
                                : line,
                            ),
                          )
                        }
                      />
                    </Field>
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={"Remove item"}
                      disabled={purchaseLines.length <= 1}
                      onClick={() =>
                        setPurchaseLines(
                          purchaseLines.filter((_, i) => i !== index),
                        )
                      }
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="purchase-form-bottom">
                <button
                  className="button button-ghost button-small"
                  type="button"
                  onClick={() =>
                    setPurchaseLines([
                      ...purchaseLines,
                      { itemId: "", quantity: "1", unitCost: "" },
                    ])
                  }
                >
                  <Plus size={14} />
                  {"Add line"}
                </button>
                <span>
                  {"Total"}
                  <strong>
                    {money(
                      Math.round(
                        purchaseLines.reduce(
                          (sum, line) =>
                            sum +
                            Number(line.quantity || 0) *
                              Number(line.unitCost || 0) *
                              100,
                          0,
                        ),
                      ),
                    )}
                  </strong>
                </span>
              </div>
              {footer("Receive purchase")}
            </form>
          )}
          {dialog === "customer" && (
            <form
              onSubmit={(event) =>
                submit(
                  event,
                  (fields) =>
                    mutate("/customers", {
                      name: value(fields, "name"),
                      phone: value(fields, "phone"),
                      email: value(fields, "email"),
                    }),
                  "Guest added to your directory",
                )
              }
            >
              <div className="form-grid">
                <Field label={"Full name"} full>
                  <input
                    className="input"
                    required
                    name="name"
                    minLength={2}
                    maxLength={100}
                    autoComplete="name"
                    placeholder={"Guest name"}
                  />
                </Field>
                <Field label={"Phone number"}>
                  <input
                    className="input"
                    name="phone"
                    type="tel"
                    required
                    maxLength={20}
                    autoComplete="tel"
                    placeholder="077 123 4567"
                  />
                </Field>
                <Field label={"Email (optional)"}>
                  <input
                    className="input"
                    name="email"
                    type="email"
                    maxLength={160}
                    autoComplete="email"
                    placeholder="guest@example.com"
                  />
                </Field>
              </div>
              {footer("Add guest")}
            </form>
          )}
          {dialog === "staff" && (
            <form
              onSubmit={(event) =>
                submit(
                  event,
                  (fields) =>
                    mutate("/staff", {
                      name: value(fields, "name"),
                      phone: value(fields, "phone"),
                      pin: value(fields, "pin"),
                      role: value(fields, "role"),
                      branchId,
                    }),
                  "Team member added",
                )
              }
            >
              <div className="form-grid">
                <Field label={"Full name"} full>
                  <input
                    className="input"
                    name="name"
                    required
                    minLength={2}
                    maxLength={100}
                  />
                </Field>
                <Field label={"Role"}>
                  <select
                    className="select"
                    name="role"
                    required
                    defaultValue="cashier"
                  >
                    {(data.user.role === "owner"
                      ? [
                          "manager",
                          "cashier",
                          "waiter",
                          "kitchen",
                          "storekeeper",
                          "accountant",
                        ]
                      : ["cashier", "waiter", "kitchen", "storekeeper"]
                    ).map((role) => (
                      <option value={role} key={role}>
                        {role[0].toUpperCase() + role.slice(1)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={"Phone number"}>
                  <input
                    className="input"
                    name="phone"
                    type="tel"
                    maxLength={20}
                  />
                </Field>
                <Field label={"Sign-in PIN (4–8 digits)"} full>
                  <input
                    className="input"
                    name="pin"
                    type="password"
                    inputMode="numeric"
                    pattern="[0-9]{4,8}"
                    required
                    minLength={4}
                    maxLength={8}
                    autoComplete="new-password"
                  />
                  <small className="field-hint">
                    {
                      "Give this PIN privately to the team member. PINs are stored as secure hashes."
                    }
                  </small>
                </Field>
              </div>
              {footer("Add team member")}
            </form>
          )}
          {dialog === "expense" && (
            <form
              onSubmit={(event) =>
                submit(
                  event,
                  (fields) =>
                    mutate("/expenses", {
                      commandId: formCommandId,
                      branchId,
                      category: value(fields, "category"),
                      description: value(fields, "description"),
                      amount: minor(fields.get("amount")),
                      paymentMethod: value(fields, "paymentMethod"),
                    }),
                  "Expense recorded",
                )
              }
            >
              <div className="form-grid">
                <Field label={"Description"} full>
                  <input
                    className="input"
                    name="description"
                    required
                    minLength={3}
                    maxLength={200}
                    placeholder={"What was this expense for?"}
                  />
                </Field>
                <Field label={"Category"}>
                  <select className="select" name="category" required>
                    {[
                      ["utilities", "Utilities", ""],
                      ["transport", "Transport", ""],
                      ["maintenance", "Maintenance", ""],
                      ["wages", "Wages", ""],
                      ["rent", "Rent", ""],
                      ["other", "Other", ""],
                    ].map(([id, en, si]) => (
                      <option value={id} key={id}>
                        {en}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={"Amount (LKR)"}>
                  <input
                    className="input"
                    name="amount"
                    type="number"
                    min="0.01"
                    step="0.01"
                    required
                  />
                </Field>
                <Field label={"Payment method"} full>
                  <select className="select" name="paymentMethod">
                    <option value="cash">
                      {"Cash — deducted from open drawer"}
                    </option>
                    <option value="bank">{"Bank transfer"}</option>
                    <option value="card">{"Card"}</option>
                  </select>
                </Field>
              </div>
              {footer("Record expense")}
            </form>
          )}
          {dialog === "shift-open" && (
            <form
              onSubmit={(event) =>
                submit(
                  event,
                  (fields) =>
                    mutate("/shifts/open", {
                      commandId: formCommandId,
                      branchId,
                      openingFloat: minor(fields.get("openingFloat")),
                    }),
                  "Cash shift opened",
                )
              }
            >
              <div className="form-grid">
                <div className="form-info">
                  <Banknote size={20} />
                  <span>
                    {
                      "Count the cash in your drawer before opening the shift. This becomes your opening float."
                    }
                  </span>
                </div>
                <Field label={"Opening float (LKR)"} full>
                  <input
                    className="input"
                    type="number"
                    name="openingFloat"
                    required
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                  />
                </Field>
              </div>
              {footer("Open shift")}
            </form>
          )}
          {dialog === "shift-close" && selectedShift && (
            <form
              onSubmit={(event) =>
                submit(
                  event,
                  (fields) =>
                    mutate(`/shifts/${selectedShift.id}/close`, {
                      commandId: formCommandId,
                      countedCash: minor(fields.get("countedCash")),
                    }),
                  "Shift closed and reconciled",
                )
              }
            >
              <div className="shift-reconcile">
                <span>{"Expected drawer cash"}</span>
                <strong>{money(selectedShift.expectedCash)}</strong>
                <small>{"Opening float + cash payments − cash expenses"}</small>
              </div>
              <div className="form-grid">
                <Field label={"Counted cash (LKR)"} full>
                  <input
                    className="input"
                    type="number"
                    name="countedCash"
                    required
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                  />
                  <small className="field-hint">
                    {
                      "Enter the actual cash in your drawer. Any difference will be recorded for review."
                    }
                  </small>
                </Field>
              </div>
              {footer("Close shift")}
            </form>
          )}
          {dialog === "customer-ledger" && selectedCustomer && (
            <>
              <div className="customer-ledger-summary">
                <span className="guest-avatar color-0">
                  {selectedCustomer.name
                    .split(" ")
                    .slice(0, 2)
                    .map((word) => word[0])
                    .join("")
                    .toUpperCase()}
                </span>
                <div>
                  <strong>{selectedCustomer.name}</strong>
                  <small>
                    {selectedCustomer.phone ||
                      selectedCustomer.email ||
                      "Registered customer"}
                  </small>
                </div>
                <div>
                  <span>Branch dues</span>
                  <strong
                    className={
                      selectedCustomer.balance > 0 ? "text-amber" : "text-mint"
                    }
                  >
                    {money(selectedCustomer.balance)}
                  </strong>
                </div>
              </div>
              {selectedCustomer.balance > 0 && (
                <form
                  className="customer-collection-form"
                  onSubmit={(event) =>
                    submit(
                      event,
                      (fields) =>
                        mutate(
                          `/customers/${selectedCustomer.id}/collections`,
                          {
                            commandId: formCommandId,
                            branchId,
                            amount: minor(fields.get("amount")),
                            method: value(fields, "method"),
                            reference: value(fields, "reference"),
                            note: value(fields, "note"),
                          },
                        ),
                      "Customer payment collected and ledger updated",
                    )
                  }
                >
                  <h3>Record a collection</h3>
                  <p>
                    Apply a payment against this customer’s outstanding balance.
                  </p>
                  <div className="form-grid">
                    <Field label="Amount received (LKR)">
                      <input
                        className="input"
                        name="amount"
                        type="number"
                        min="0.01"
                        max={selectedCustomer.balance / 100}
                        step="0.01"
                        required
                        defaultValue={selectedCustomer.balance / 100}
                      />
                    </Field>
                    <Field label="Payment method">
                      <select
                        className="select"
                        name="method"
                        defaultValue={activeShift ? "cash" : "card"}
                      >
                        <option value="cash" disabled={!activeShift}>
                          Cash{!activeShift ? " — open a cash shift first" : ""}
                        </option>
                        <option value="card">Card</option>
                        <option value="qr">QR / bank payment</option>
                      </select>
                    </Field>
                    <Field label="Reference (optional)">
                      <input
                        className="input"
                        name="reference"
                        maxLength={120}
                        placeholder="Bank or card reference"
                      />
                    </Field>
                    <Field label="Note (optional)">
                      <input
                        className="input"
                        name="note"
                        maxLength={300}
                        placeholder="Payment note"
                      />
                    </Field>
                  </div>
                  <div className="form-error" role="alert">
                    {error}
                  </div>
                  <div className="form-actions">
                    <button
                      className="button button-primary"
                      type="submit"
                      disabled={busy}
                    >
                      <Check size={15} />
                      {busy ? "Recording…" : "Record collection"}
                    </button>
                  </div>
                </form>
              )}
              <div className="customer-ledger-heading">
                <h3>Account history</h3>
                <button
                  className="button button-ghost button-small"
                  onClick={() =>
                    downloadCSV(
                      `demo-hotel-customer-${selectedCustomer.id}-ledger.csv`,
                      [
                        [
                          "Date",
                          "Type",
                          "Order / reference",
                          "Payment method",
                          "Amount (LKR)",
                          "Note",
                        ],
                        ...customerEntries.map((entry) => [
                          entry.createdAt,
                          entry.type,
                          entry.reference ||
                            (entry.orderId
                              ? data.orders.find(
                                  (order) => order.id === entry.orderId,
                                )?.number || entry.orderId
                              : ""),
                          entry.method,
                          entry.amount / 100,
                          entry.note,
                        ]),
                      ],
                    )
                  }
                >
                  <Download size={13} />
                  Export ledger
                </button>
              </div>
              <div className="table-scroll customer-ledger-table">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Transaction</th>
                      <th>Reference</th>
                      <th>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {customerEntries.map((entry) => (
                      <tr key={entry.id}>
                        <td className="muted">{dateTime(entry.createdAt)}</td>
                        <td>
                          <div className="customer-entry-type">
                            <Pill
                              tone={entry.type === "sale" ? "amber" : "green"}
                            >
                              {entry.type === "sale"
                                ? "Credit sale"
                                : entry.type === "collection"
                                  ? "Payment received"
                                  : "Credit refund"}
                            </Pill>
                            <small>{entry.note || entry.method}</small>
                            {entry.type==='sale'&&entry.orderId&&<small className="customer-credit-items">Bill items: {data.orders.find(order=>order.id===entry.orderId)?.lines.map(line=>`${line.name} × ${line.quantity} (${money(line.lineTotal)})`).join(' · ')||'Historical bill details unavailable'}</small>}
                          </div>
                        </td>
                        <td>
                          {entry.reference ||
                            (entry.orderId
                              ? data.orders.find(
                                  (order) => order.id === entry.orderId,
                                )?.number || "Order"
                              : "—")}
                        </td>
                        <td
                          className={
                            entry.type === "sale" ? "text-amber" : "text-mint"
                          }
                        >
                          {entry.type === "sale" ? "+" : "−"}
                          {money(entry.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!customerEntries.length && (
                  <Empty
                    title="No credit transactions"
                    subtitle="Credit sales and customer collections will appear here."
                  />
                )}
              </div>
              <div className="customer-ledger-footer">
                <ShieldCheck size={13} />
                This ledger and balance belong to {data.branch.name}.
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
