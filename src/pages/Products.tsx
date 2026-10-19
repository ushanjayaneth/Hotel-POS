import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Barcode,
  Check,
  ChevronDown,
  Download,
  Layers3,
  Package,
  Plus,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Tag,
  X,
} from "lucide-react";
import type { Category, InventoryItem, MenuItem } from "../../shared/types";
import { usePOS } from "../lib/context";
import { commandId, money, number } from "../lib/format";
import { useBackLayer } from "../lib/navigation";
import { isProductImageReference } from "../../shared/media";
import PhotoPicker from "../components/PhotoPicker";
import ProductPhoto from "../components/ProductPhoto";
import "../styles/products.css";

type Product = MenuItem & {
  barcode?: string;
  sku?: string;
  reorderLevel?: number;
};

function Dialog({
  title,
  subtitle,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  const dialogRef = useRef<HTMLElement>(null);
  closeRef.current = onClose;
  busyRef.current = busy;
  useBackLayer(
    true,
    () => {
      if (busyRef.current) return false;
      closeRef.current();
    },
    `product:${title}`,
  );

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const input = dialog?.querySelector<HTMLElement>("input,select");
    input?.focus();
    const handleKey = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll(".product-dialog");
      if (dialogs[dialogs.length - 1] !== dialog) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busyRef.current) closeRef.current();
      }
      if (event.key !== "Tab" || !dialog) return;
      const elements = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          "input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled])",
        ),
      );
      if (event.shiftKey && document.activeElement === elements[0]) {
        event.preventDefault();
        elements.at(-1)?.focus();
      } else if (
        !event.shiftKey &&
        document.activeElement === elements.at(-1)
      ) {
        event.preventDefault();
        elements[0]?.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      previous?.focus();
    };
  }, []);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="modal product-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="product-dialog-header">
          <div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close dialog"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function Field({
  label,
  children,
  full = false,
}: {
  label: string;
  children: ReactNode;
  full?: boolean;
}) {
  return (
    <label className={`field ${full ? "product-field-full" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function CategoryDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated?: (id: string) => void;
}) {
  const { mutate, refresh, notify } = usePOS();
  const [requestId] = useState(commandId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await mutate<{ category: Category }>("/categories", {
        commandId: requestId,
        name: String(fields.get("name") || "").trim(),
        icon: String(fields.get("icon") || "utensils"),
      });
      await refresh();
      onCreated?.(result.category.id);
      notify("Category added");
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to create the category.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Add category"
      subtitle="Organise your products into clear, useful groups."
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Category name" full>
            <input
              className="input"
              name="name"
              required
              minLength={2}
              maxLength={80}
              placeholder="e.g. Fresh juices"
              autoComplete="off"
            />
          </Field>
          <Field label="Category icon" full>
            <select className="select" name="icon" defaultValue="utensils">
              <option value="utensils">Food & meals</option>
              <option value="coffee">Drinks</option>
              <option value="flame">Grill & hot food</option>
              <option value="cake">Desserts</option>
              <option value="package">Retail products</option>
              <option value="leaf">Vegetarian</option>
            </select>
          </Field>
        </div>
        {error && (
          <div className="error-message product-form-error" role="alert">
            {error}
          </div>
        )}
        <div className="form-actions">
          <button
            className="button button-ghost"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="button button-primary" disabled={busy}>
            {busy ? "Saving…" : "Add category"}
            <Check size={15} />
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function ProductDialog({
  onClose,
  categoryId,
  item,
}: {
  onClose: () => void;
  categoryId?: string;
  item?: MenuItem;
}) {
  const { data, branchId, mutate, refresh, notify } = usePOS();
  const product = item as Product | undefined;
  const linkedStock = item
    ? data.inventory.find(
        (stock) =>
          stock.branchId === branchId &&
          stock.menuItemId === item.id &&
          ["prepared", "resale"].includes(stock.category),
      )
    : undefined;
  const [requestId] = useState(commandId);
  const [stockRequestId] = useState(commandId);
  const [selectedCategory, setSelectedCategory] = useState(
    product?.categoryId || categoryId || data.categories[0]?.id || "",
  );
  const [stockMode, setStockMode] = useState<MenuItem["stockMode"]>(
    product?.stockMode || "prepared",
  );
  const [stockType, setStockType] = useState<"prepared" | "resale">(
    linkedStock?.category === "resale" ? "resale" : "prepared",
  );
  const [quantity, setQuantity] = useState(String(linkedStock?.quantity ?? 0));
  const [manageStock, setManageStock] = useState(
    item ? Boolean(linkedStock) : true,
  );
  const [stockUnit, setStockUnit] = useState(linkedStock?.unit || "portions");
  const [categoryDialog, setCategoryDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const savedProductId = useRef<string | null>(item?.id || null);
  const stockSaved = useRef(false);
  const [image, setImage] = useState(product?.image || "");
  const [photoBusy, setPhotoBusy] = useState(false);
  const [sellingPrice, setSellingPrice] = useState(product ? String(product.price / 100) : "");
  const [purchaseCost, setPurchaseCost] = useState(String((linkedStock?.unitCost ?? product?.cost ?? 0) / 100));
  const previewPrice = Math.round(Number(sellingPrice || 0) * 100);
  const previewCost = Math.round(Number(purchaseCost || 0) * 100);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || photoBusy) return;
    const fields = new FormData(event.currentTarget);
    const text = (key: string) => String(fields.get(key) || "").trim();
    const cents = (key: string) =>
      Math.round(Number(fields.get(key) || 0) * 100);
    const payload = {
      commandId: requestId,
      name: text("name"),
      description: text("description"),
      categoryId: selectedCategory,
      price: cents("price"),
      cost: cents("cost"),
      image: image.trim() || "/images/chicken-rice.jpg",
      available: fields.get("enabled") === "on",
      stockMode,
      preparationMinutes: Number(fields.get("preparationMinutes") || 0),
      barcode: text("barcode"),
      sku: text("sku").toUpperCase(),
      reorderLevel: Number(fields.get("minimum") || 0),
    };
    if (!selectedCategory) {
      setError("Choose or create a category first.");
      return;
    }
    if (!isProductImageReference(payload.image)) {
      setError("Use an HTTPS image link or upload a product photo.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await mutate<{ item: MenuItem }>(
        item ? `/menu/${item.id}` : "/menu",
        payload,
        item ? "PATCH" : "POST",
      );
      savedProductId.current = result.item.id;
      if (stockMode === "prepared" && manageStock && !stockSaved.current) {
        const requested = Number(quantity);
        if (!Number.isFinite(requested) || requested < 0)
          throw new Error("Enter a valid, non-negative stock quantity.");
        if (linkedStock) {
          await mutate(
            `/inventory/${linkedStock.id}`,
            {
              commandId: stockRequestId,
              branchId,
              quantity: requested,
              minimum: payload.reorderLevel,
              unitCost: payload.cost,
              expectedQuantity: linkedStock.quantity,
              reason: "Product stock count updated",
            },
            "PATCH",
          );
        } else {
          await mutate("/inventory", {
            commandId: stockRequestId,
            branchId,
            name: payload.name,
            category: stockType,
            unit: text("unit") || "pcs",
            quantity: requested,
            minimum: payload.reorderLevel,
            unitCost: payload.cost,
            menuItemId: result.item.id,
            supplierId: null,
          });
        }
        stockSaved.current = true;
      }
      await refresh();
      notify(item ? "Product updated" : "Product added");
      onClose();
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Unable to save this product.";
      setError(
        savedProductId.current && !item
          ? `Product saved. Stock setup needs attention: ${message} Retry to finish.`
          : message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog
        title={item ? "Edit product" : "Add product"}
        subtitle="Menu details apply across branches. Stock quantities apply to the selected branch."
        onClose={onClose}
        busy={busy || photoBusy}
      >
        <form onSubmit={submit}>
          <div className="form-grid">
            <Field label="Product name" full>
              <input
                className="input"
                name="name"
                required
                minLength={2}
                maxLength={120}
                defaultValue={product?.name || ""}
                placeholder="e.g. Chicken fried rice"
              />
            </Field>
            <Field label="Category">
              <div className="product-category-field">
                <select
                  className="select"
                  aria-label="Category"
                  value={selectedCategory}
                  onChange={(event) => setSelectedCategory(event.target.value)}
                  required
                >
                  <option value="">Choose category</option>
                  {data.categories.map((category) => (
                    <option value={category.id} key={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="Add category"
                  onClick={() => setCategoryDialog(true)}
                >
                  <Plus size={16} />
                </button>
              </div>
            </Field>
            <Field label="Stock tracking">
              <select
                className="select"
                value={stockMode}
                onChange={(event) =>
                  setStockMode(event.target.value as MenuItem["stockMode"])
                }
              >
                <option value="prepared">Track product quantity</option>
                <option value="recipe">Deduct recipe ingredients</option>
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
                value={sellingPrice}
                onChange={(event) => setSellingPrice(event.target.value)}
                placeholder="0.00"
              />
            </Field>
            <Field label="Cost per unit (LKR)">
              <input
                className="input"
                name="cost"
                type="number"
                min="0"
                step="0.01"
                required
                value={purchaseCost}
                onChange={(event) => setPurchaseCost(event.target.value)}
              />
            </Field>
            <div className="product-profit-preview product-field-full" aria-label="Product profit preview">
              <span>Gross profit per unit <strong>{money(previewPrice - previewCost)}</strong></span>
              <span>Gross margin <strong>{previewPrice > 0 ? `${((previewPrice - previewCost) / previewPrice * 100).toFixed(1)}%` : '—'}</strong></span>
              <small>{stockMode === 'recipe' ? 'Use the recipe editor to calculate ingredient cost per portion. This preview uses the entered unit cost.' : 'Before discounts, tax and operating expenses. Sales retain their cost when confirmed.'}</small>
            </div>
            <Field label="Barcode (optional)">
              <div className="product-barcode-field">
                <Barcode size={16} />
                <input
                  className="input"
                  name="barcode"
                  maxLength={80}
                  defaultValue={product?.barcode || ""}
                  placeholder="Scan or enter barcode"
                  autoComplete="off"
                />
              </div>
            </Field>
            <Field label="SKU (optional)">
              <input
                className="input product-sku"
                name="sku"
                maxLength={60}
                defaultValue={product?.sku || ""}
                placeholder="e.g. FOOD-001"
                autoComplete="off"
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
                defaultValue={product?.preparationMinutes ?? 10}
              />
            </Field>
            <Field label="Reorder alert level">
              <input
                className="input"
                name="minimum"
                type="number"
                min="0"
                max="100000"
                step="0.001"
                required
                defaultValue={
                  linkedStock?.minimum ?? product?.reorderLevel ?? 10
                }
              />
            </Field>
            <PhotoPicker value={image} onChange={setImage} onBusyChange={setPhotoBusy} disabled={busy} />
            <Field label="Description (optional)" full>
              <textarea
                className="input"
                name="description"
                maxLength={500}
                rows={2}
                defaultValue={product?.description || ""}
              />
            </Field>
            <label className="product-checkbox product-field-full">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={product?.enabled !== false}
              />
              <span>Available on the menu</span>
            </label>
          </div>
          {stockMode === "prepared" && (
            <section className="product-stock-setup">
              <label className="product-checkbox">
                <input
                  type="checkbox"
                  checked={manageStock}
                  onChange={(event) => setManageStock(event.target.checked)}
                />
                <span>
                  <strong>
                    {linkedStock
                      ? "Update branch stock count"
                      : "Set up branch stock"}
                  </strong>
                  <small>{data.branch.name} · this location only</small>
                </span>
              </label>
              {manageStock && (
                <div className="form-grid">
                  {!linkedStock && (
                    <>
                      <Field label="Product type">
                        <select
                          className="select"
                          value={stockType}
                          onChange={(event) => {
                            setStockType(
                              event.target.value as "prepared" | "resale",
                            );
                            setStockUnit(
                              event.target.value === "resale"
                                ? "pcs"
                                : "portions",
                            );
                          }}
                        >
                          <option value="prepared">Prepared food</option>
                          <option value="resale">
                            Retail / resale product
                          </option>
                        </select>
                      </Field>
                      <Field label="Stock unit">
                        <select
                          className="select"
                          name="unit"
                          value={stockUnit}
                          onChange={(event) => setStockUnit(event.target.value)}
                        >
                          <option value="portions">Portions</option>
                          <option value="pcs">Pieces</option>
                          <option value="bottles">Bottles</option>
                          <option value="packs">Packs</option>
                          <option value="kg">Kilograms</option>
                        </select>
                      </Field>
                    </>
                  )}
                  <Field
                    label={
                      linkedStock
                        ? `Counted stock (${linkedStock.unit})`
                        : "Opening stock quantity"
                    }
                    full
                  >
                    <input
                      className="input"
                      type="number"
                      min="0"
                      max="100000"
                      step="0.001"
                      required
                      value={quantity}
                      onChange={(event) => setQuantity(event.target.value)}
                    />
                    {linkedStock && (
                      <small>
                        Current recorded stock: {number(linkedStock.quantity)}{" "}
                        {linkedStock.unit}. The difference is recorded as an
                        audited adjustment.
                      </small>
                    )}
                  </Field>
                </div>
              )}
            </section>
          )}
          {stockMode === "recipe" && (
            <p className="product-help">
              <ShieldCheck size={15} />
              Configure the recipe in Production after saving. Ingredients are
              deducted when the order is confirmed.
            </p>
          )}
          {error && (
            <div className="error-message product-form-error" role="alert">
              {error}
            </div>
          )}
          <div className="form-actions">
            <button
              className="button button-ghost"
              type="button"
              onClick={onClose}
              disabled={busy || photoBusy}
            >
              Cancel
            </button>
            <button className="button button-primary" disabled={busy || photoBusy}>
              {busy ? "Saving…" : item ? "Save product" : "Add product"}
              <Check size={15} />
            </button>
          </div>
        </form>
      </Dialog>
      {categoryDialog && (
        <CategoryDialog
          onClose={() => setCategoryDialog(false)}
          onCreated={setSelectedCategory}
        />
      )}
    </>
  );
}

export default function Products() {
  const { data, branchId } = usePOS();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [stockFilter, setStockFilter] = useState("all");
  const [editing, setEditing] = useState<MenuItem | null | undefined>(
    undefined,
  );
  const [categoryDialog, setCategoryDialog] = useState(false);
  const canEdit = ["owner", "manager"].includes(data.user.role);
  const products = data.menu as Product[];
  const stockFor = (product: Product) =>
    data.inventory.find(
      (stock) =>
        stock.branchId === branchId &&
        stock.menuItemId === product.id &&
        ["prepared", "resale"].includes(stock.category),
    );
  const lowStock = products.filter((product) => {
    const stock = stockFor(product);
    return stock && stock.quantity <= stock.minimum;
  });
  const filtered = products.filter((product) => {
    const stock = stockFor(product);
    return (
      (category === "all" || product.categoryId === category) &&
      `${product.name} ${product.description} ${product.barcode || ""} ${product.sku || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (stockFilter === "all" ||
        (stockFilter === "low" && stock && stock.quantity <= stock.minimum) ||
        (stockFilter === "unavailable" && !product.available))
    );
  });

  function exportProducts() {
    const rows = [
      [
        "Product",
        "Category",
        "SKU",
        "Barcode",
        "Price (LKR)",
        "Cost (LKR)",
        "Stock quantity",
        "Stock unit",
        "Tracking",
      ],
      ...filtered.map((product) => {
        const stock = stockFor(product);
        return [
          product.name,
          data.categories.find((category) => category.id === product.categoryId)
            ?.name || "",
          product.sku || "",
          product.barcode || "",
          product.price / 100,
          product.cost / 100,
          stock?.quantity ?? "",
          stock?.unit || "",
          product.stockMode,
        ];
      }),
    ];
    const csv =
      "\ufeff" +
      rows
        .map((row) =>
          row
            .map((value) => `"${String(value).replaceAll('"', '""')}"`)
            .join(","),
        )
        .join("\r\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "demo-hotel-products.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="products-page">
      <header className="page-heading">
        <div>
          <div className="eyebrow">
            <span className="status-dot" /> YOUR PRODUCT CATALOGUE
          </div>
          <h1>Products</h1>
          <p className="page-subtitle">
            Every dish, every detail. Organised and ready to sell.
          </p>
        </div>
        <div className="products-heading-actions">
          <button className="button button-ghost" onClick={exportProducts}>
            <Download size={15} />
            Export
          </button>
          {canEdit && (
            <>
              <button
                className="button button-ghost"
                onClick={() => setCategoryDialog(true)}
              >
                <Layers3 size={15} />
                Add category
              </button>
              <button
                className="button button-primary"
                onClick={() => setEditing(null)}
              >
                <Plus size={16} />
                Add product
              </button>
            </>
          )}
        </div>
      </header>
      <div className="products-summary">
        <div className="panel product-summary-card">
          <span>
            <Package size={17} />
            Total products
          </span>
          <strong>{number(products.length)}</strong>
          <small>Your full catalogue</small>
        </div>
        <div className="panel product-summary-card">
          <span>
            <Layers3 size={17} />
            Categories
          </span>
          <strong>{number(data.categories.length)}</strong>
          <small>Made easy to find</small>
        </div>
        <div className="panel product-summary-card">
          <span>
            <Tag size={17} />
            Available now
          </span>
          <strong>
            {number(products.filter((product) => product.available).length)}
          </strong>
          <small>Ready for your next order</small>
        </div>
        <div className="panel product-summary-card">
          <span>
            <Barcode size={17} />
            Low stock
          </span>
          <strong>{number(lowStock.length)}</strong>
          <small>Below the reorder level</small>
        </div>
      </div>
      <section className="panel products-catalogue">
        <div className="products-toolbar">
          <div className="products-search">
            <Search size={16} />
            <input
              type="search"
              aria-label="Search products"
              placeholder="Search name, SKU or barcode…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="products-filters">
            <label>
              <Layers3 size={14} />
              <select
                aria-label="Product category"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                <option value="all">All categories</option>
                {data.categories.map((category) => (
                  <option value={category.id} key={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={13} />
            </label>
            <label>
              <SlidersHorizontal size={14} />
              <select
                aria-label="Product stock status"
                value={stockFilter}
                onChange={(event) => setStockFilter(event.target.value)}
              >
                <option value="all">All stock statuses</option>
                <option value="low">Low stock</option>
                <option value="unavailable">Unavailable</option>
              </select>
              <ChevronDown size={13} />
            </label>
          </div>
        </div>
        <div className="products-table-scroll">
          <table className="data-table products-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Barcode / SKU</th>
                <th>Selling price</th>
                <th>Unit cost</th>
                <th>Branch stock</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((product) => {
                const stock = stockFor(product);
                return (
                  <tr key={product.id}>
                    <td>
                      <div className="product-table-name">
                        <div className="product-table-image">
                          {product.image ? (
                            <ProductPhoto src={product.image} alt="" loading="lazy" />
                          ) : (
                            <Package size={20} />
                          )}
                        </div>
                        <div>
                          <strong>{product.name}</strong>
                          <small>
                            {data.categories.find(
                              (category) => category.id === product.categoryId,
                            )?.name || "Uncategorised"}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="product-identifiers">
                        <span>{product.barcode || "No barcode"}</span>
                        <small>{product.sku || "—"}</small>
                      </div>
                    </td>
                    <td>
                      <strong>{money(product.price)}</strong>
                    </td>
                    <td>{money(product.cost)}</td>
                    <td>
                      {stock ? (
                        <div
                          className={`product-stock ${stock.quantity <= stock.minimum ? "low" : ""}`}
                        >
                          <strong>
                            {number(stock.quantity)} <span>{stock.unit}</span>
                          </strong>
                          <small>Reorder at {number(stock.minimum)}</small>
                        </div>
                      ) : (
                        <span className="product-untracked">
                          {product.stockMode === "recipe"
                            ? "Recipe ingredients"
                            : product.stockMode === "prepared"
                              ? "Stock not set up"
                              : "Not tracked"}
                        </span>
                      )}
                    </td>
                    <td>
                      <span
                        className={`product-status ${product.available ? "available" : ""}`}
                      >
                        <i />
                        {product.enabled === false
                          ? "Disabled"
                          : product.available
                            ? "Available"
                            : "Out of stock"}
                      </span>
                    </td>
                    <td>
                      {canEdit && (
                        <button
                          className="button button-ghost button-small"
                          aria-label={`Edit ${product.name}`}
                          onClick={() => setEditing(product)}
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
        </div>
        {!filtered.length && (
          <div className="empty-state">
            <div className="empty-icon">
              <Search size={25} />
            </div>
            <h3>No products found</h3>
            <p>Try another name, barcode or category.</p>
            <button
              className="button button-ghost"
              onClick={() => {
                setSearch("");
                setCategory("all");
                setStockFilter("all");
              }}
            >
              Reset filters
            </button>
          </div>
        )}
        <footer className="products-table-footer">
          <span>
            {filtered.length} of {products.length} products
          </span>
          <span>
            <ShieldCheck size={13} />
            Stock shown for {data.branch.name}
          </span>
        </footer>
      </section>
      {editing !== undefined && (
        <ProductDialog
          item={editing || undefined}
          categoryId={category === "all" ? undefined : category}
          onClose={() => setEditing(undefined)}
        />
      )}
      {categoryDialog && (
        <CategoryDialog onClose={() => setCategoryDialog(false)} />
      )}
    </div>
  );
}
