# DEMO HOTEL

A restaurant workspace with a dark glass interface, responsive cashier screens, a kitchen display, and branch management. It runs on phones, tablets, laptops, and desktops. Choose a standalone **device workspace** for full offline transactions in IndexedDB, a **Node.js branch hub** for transactions across a local network, or the backend-configured **Firebase shared online workspace** across remote devices.

This is a working foundation for the [POS master plan](POS-MASTER-PLAN.si.md), with demonstration data for Colombo, Kandy, and Galle. It needs site configuration, cloud integration, hardware testing, and an operational pilot before live trading.

## Use without a paid backend

For an independent offline workspace, open `/?local=1` on the trusted HTTPS deployment and choose **Set up this device** and create your own private **6–12 digit owner PIN**. Sample data is optional. There is no fixed owner PIN for a new device workspace. Once setup and the initial app cache complete, the same browser/profile can record bills, payments, stock, and expenses offline without a Node backend. Setup does not repeat while the saved workspace remains present.

Each device workspace is independent; bills and stock do not automatically merge with other devices or Firebase. Use the configured shared cloud workspace across online devices, or a branch hub across the local network. Export encrypted `.hotelbackup` files from Settings and keep copies off-device. There is no app-imposed total-record cap or automatic deletion, but browser quotas and site-data clearing still apply. See the [device workspace guide](docs/DEVICE-WORKSPACE.md) for setup, backup/restore, photos, and food costing.

See [register sales and customer dues](docs/POS-SALES.md) for per-product low-stock alerts, item/cart discounts in LKR, tableless counter sales, POS credit customers, and partial repayments.

For customer delivery, complete the [handover and acceptance record](docs/CUSTOMER-HANDOVER.md) and provide the [owner quick start](docs/OWNER-QUICK-START.md) with the installation's agreed backup and support details.

## Run locally

Install **Node.js 24.14 or later**. The hub uses Node's built-in SQLite module.

```powershell
npm install
npm run dev
```

Open **http://localhost:5173**. The development server forwards `/api` to the branch hub on port `3001`. To evaluate hub mode, select **Explore demo workspace**, or enter one of these public demonstration PINs:

| Role | Demo PIN |
| --- | --- |
| Owner | `1234` |
| Cashier | `2222` |
| Waiter | `3333` |
| Kitchen | `4444` |
| Storekeeper | `5555` |
| Manager | `6666` |
| Accountant | `7777` |

These demo PINs apply only to the sample hub database. A standalone workspace uses its privately chosen setup PIN. Never use the demo database for real business records. The default hub database is `data/demo-hotel.sqlite`.

On Windows PowerShell machines that block `npm.ps1`, use `npm.cmd` and `npx.cmd` for these commands, or run them in Command Prompt. No execution-policy change is needed.

## Build and serve

```powershell
npm run build
npm start
```

The hub serves the built app and API together at **http://localhost:3001**. Build again after changing the frontend. Run it as a supervised service for a deployed branch, with a trusted HTTPS reverse proxy and a dedicated database path.

Environment variables are documented in [.env.example](.env.example). `npm start`, `npm run dev`, and `npm run start:cloud` load an optional local `.env` file. It is ignored by Git and must never be committed. Keep the Firebase URL and server credentials there, outside the browser. To launch manually:

```powershell
node --env-file=.env --import tsx server/index.ts
```

For the first non-demo run, use a **new** `DATABASE_PATH`, `POS_DEMO_MODE=false`, and a unique 6–12 digit `INITIAL_ADMIN_PIN`. Setting demo mode to false does not remove records or change credentials in an existing initialized database. See the [operations runbook](docs/OPERATIONS.md) before deploying.

## Included workflows

- Cashier menu search and category filtering, dine-in/takeaway/delivery orders, table selection, item instructions, discounts, and receipts.
- Kitchen preparation states and active order tracking, cash/card/QR payment records, partial payments, refunds, and cash shifts.
- Ingredients and prepared stock, recipe consumption, production batches, purchase receiving, suppliers, customers, and staff roles.
- Branch views, expenses, reports, audit history, verified local database backups, and a durable outgoing sync queue.
- Responsive layouts, installable PWA assets, device-local drafts, and saved workspace data for hub outages.
- Step-by-step in-app Back navigation, editable keyboard shortcuts, and a device-local text-size slider.
- Products with prices, barcodes/SKUs and branch stock; category and product creation directly from Point of sale.
- Shared held bills with stale-edit protection, customer credit and collections, searchable sales history, income/expense statements and day-end CSV downloads.
- Receipt paper/content widths, margins and horizontal offset in millimetres; printer discovery, LAN port checks and scanner input tests.
- Full standalone IndexedDB transactions, private local PIN accounts, atomic command replay protection, encrypted worker-based backup/restore, and device storage diagnostics.
- Product photo URL or JPEG/PNG/WebP upload, compressed before saving to JPEG at most 700,000 bytes with a maximum 1,600-pixel edge. Uploaded local bytes remain available offline.
- Recipe batch yields, ingredient/packaging costs, weighted stock costs, historical unit costs captured on confirmed bills, daily/product profit views, and profit CSV downloads.

Card and QR entries record externally verified payments; they do not initiate a bank or card charge. Printing uses the browser print flow. LAN printer routing, cash drawer control, and payment terminal integration require separate hardware integration and testing.

## Vercel and backend hosting

The repository deploys the Vite frontend and `/api/cloud` Node function together using `vercel.json`. For shared online POS, environment setup and authenticated recovery, follow [the Vercel/Firebase guide](docs/CLOUD-SYNC.md). This cloud path does not require a separately hosted Render SQLite API. Its Firebase service account, `CLOUD_POS_PIN_HASH` and session signing secret stay on the backend; a successful build alone does not connect a live database.

A static frontend also supports an independent **device workspace** without a backend: choose **Set up this device** after app caching. Confirmed local sales work offline and stay inside that browser. For multiple online devices using one stock/loan balance, open the normal app address and enter the same ordinary POS PIN when requested. The backend opens the shop automatically, with no separate cloud admin login, workspace picker or Settings connection form. The first original-device transfer finishes its upload before becoming shared. Shared confirmations require internet; independent local sales do not merge automatically.

The optional [Render backend guide](docs/HOSTING-VERCEL-RENDER.md) describes the separate SQLite hub topology. Its persistent-disk requirement applies to that topology; the files in `deployment/` are inactive templates.

Settings saves text size, shortcuts and receipt alignment on each browser/device. Defaults include F2 search, F3 new bill, F4 hold, F8 payment, F9 kitchen, F10 receipt and Alt+0 settings; open the keyboard icon for the current assignments. Back closes the most recent dialog, drawer or POS filter before returning to the previous workspace screen. It does not reverse a saved sale or prevent a user from closing a browser tab.

Printer discovery describes the machine running the hub. With a cloud-hosted hub it cannot discover a cashier's local printer queues or private LAN. Use browser printer selection and an actual test receipt at the register. Scanner keyboard mode works through received input; supported desktop browsers can also offer a consent-based HID chooser. A responding network port is not proof that paper printed.

## Offline and cloud behavior

In **device workspace mode**, confirmed orders, payments, stock, expenses, and local uploaded photos work offline after initial setup/app caching. The database remains inside the current browser profile and is not shared across devices. Installation does not bypass browser quota or protect against device/site-data loss; keep encrypted backups.

In **hub mode**, devices connected to the running branch hub over LAN/Wi-Fi continue through an internet outage. A device disconnected from the hub can view its saved snapshot and retain drafts, but confirming orders/payments requires the hub. Switching modes does not migrate or merge their separate records.

The server queues committed changes in SQLite and can send them to the included [Firebase receiver](server/cloud.ts). The receiver authenticates each branch hub, stores an immutable event ledger and a sequenced projection in Firebase Realtime Database, and acknowledges durable writes. **Provide the Firebase origin and server credentials through a private environment. No credentials are included in this repository.** The Firebase URL remains server-only and is never included in the bootstrap response. On a branch hub, configure `SYNC_ENDPOINT`, `SYNC_TOKEN`, and `HUB_ID` to connect it to the deployed receiver. Run the receiver separately with `npm run start:cloud` and server-side Firebase credentials. See the [deployment contract](docs/OPERATIONS.md#firebase-sync-integration).

That separate hub receiver is one-way replication of a branch baseline and subsequent changes. The Vercel `/api/cloud` path additionally supports shared online transactions and authenticated reopening after browser data loss. Open the normal app address and use the private POS PIN; the shop opens automatically without a cloud account or workspace selection. No public default PIN is created and no independent local database is silently overwritten. Cloud recovery covers acknowledged business records, excluding unuploaded local sales, device drafts, uploaded local photo bytes and local credentials. Keep independent backups and validate the real Firebase deployment.

Standalone photo copies retry when online only if a same-origin backend already has an authenticated Owner/Manager session. Without it, photos remain locally queued; local bytes are never removed after upload. Acknowledged hub media can enter the separately configured Firebase receiver. This does not synchronize device bills or stock. External photo URLs remain network dependent. Profit reports use confirmed bills including credit/unpaid bills, with saved costs where available; cash-flow reports measure money received/paid and can differ. See [food costs and profit](docs/DEVICE-WORKSPACE.md#food-costs-and-profit).

Use a trusted HTTPS origin for phone/tablet PWA installation and service-worker caching; localhost is supported for local development. An ordinary HTTP LAN address supports browser access but does not provide a production PWA secure context. [Browser secure-context requirements](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts). Browser storage can be cleared or evicted, so retain independent backups.

## Verification

```powershell
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Browser tests start an isolated hub on port `3101`, use a new temporary SQLite database, and disable cloud sync. They exercise menu/cart behavior, kitchen handoff and cash payment, hub outage drafts, step-by-step Back, text/shortcut/receipt preferences, held-bill updates, barcoded product setup, customer credit/collection, statement downloads, and mobile navigation. Build before running them; they use the production frontend files in `dist`. Failures retain a screenshot and browser trace in `test-results`. The tests leave the normal development database untouched. Do not direct this suite at a live branch.

To use an already installed Google Chrome, set `PLAYWRIGHT_CHANNEL=chrome` in the test process environment. Hub browser tests block service workers for deterministic network checks; standalone tests exercise service-worker caching, IndexedDB, offline transactions, encrypted backup/restore, photo compression, and profitability with backend requests unavailable. Installed-PWA and physical device/printer checks remain part of the site pilot.

## Deployment scope

This implementation has not been certified for Sri Lankan tax, payroll, accounting, privacy, or fiscal receipt requirements. Tax/service-charge settings are configurable and default to zero; an authorized accountant must set the correct rules for the business. The master plan includes additional integrations and operational requirements beyond this initial implementation.

Operational deployment, backup/restore, security, and cloud details are in [docs/OPERATIONS.md](docs/OPERATIONS.md). Real demonstration photographs and their licenses are listed in [docs/ASSET-CREDITS.md](docs/ASSET-CREDITS.md).
