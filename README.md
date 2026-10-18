# DEMO HOTEL

A local-first restaurant workspace with a dark glass interface, responsive cashier screens, a kitchen display, and branch management. The web app runs on phones, tablets, laptops, and desktops with a modern browser. A Node.js branch hub stores confirmed transactions in SQLite; the browser keeps local order drafts and cached workspace data.

This is a working foundation for the [POS master plan](POS-MASTER-PLAN.si.md), with demonstration data for Colombo, Kandy, and Galle. It needs site configuration, cloud integration, hardware testing, and an operational pilot before live trading.

## Run locally

Install **Node.js 24.14 or later**. The hub uses Node's built-in SQLite module.

```powershell
npm install
npm run dev
```

Open **http://localhost:5173**. The development server forwards `/api` to the branch hub on port `3001`. Select **Explore demo workspace**, or enter one of these public demonstration PINs:

| Role | Demo PIN |
| --- | --- |
| Owner | `1234` |
| Cashier | `2222` |
| Waiter | `3333` |
| Kitchen | `4444` |
| Storekeeper | `5555` |
| Manager | `6666` |
| Accountant | `7777` |

Demo PINs and sample records are for local evaluation. Never use the demo database for real business records. The default database is `data/demo-hotel.sqlite`.

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

Card and QR entries record externally verified payments; they do not initiate a bank or card charge. Printing uses the browser print flow. LAN printer routing, cash drawer control, and payment terminal integration require separate hardware integration and testing.

## Offline and cloud behavior

When the internet is down, devices connected to the **running branch hub over LAN/Wi-Fi** can continue using its local database. When a device cannot reach the hub, it can view its saved workspace and retain local order drafts. Confirming orders and taking payments require the hub. A phone's private browser storage is not a shared transaction database or a backup.

The server queues committed changes in SQLite and can send them to the included [Firebase receiver](server/cloud.ts). The receiver authenticates each branch hub, stores an immutable event ledger and a sequenced projection in Firebase Realtime Database, and acknowledges durable writes. **Provide the Firebase origin and server credentials through a private environment. No credentials are included in this repository.** The Firebase URL remains server-only and is never included in the bootstrap response. On a branch hub, configure `SYNC_ENDPOINT`, `SYNC_TOKEN`, and `HUB_ID` to connect it to the deployed receiver. Run the receiver separately with `npm run start:cloud` and server-side Firebase credentials. See the [deployment contract](docs/OPERATIONS.md#firebase-sync-integration).

This is one-way replication of a branch baseline and subsequent changes. Cloud copies intentionally exclude credential hashes, sessions, and local command tables. Central cloud dashboards, remote branch command routing, bidirectional merges, and cloud-to-local recovery are not implemented. Keep independent full SQLite backups and validate a real Firebase deployment before multi-branch trading.

Use a trusted HTTPS origin for phone/tablet PWA installation and service-worker caching; localhost is supported for local development. An ordinary HTTP LAN address supports browser access but does not provide a production PWA secure context. [Browser secure-context requirements](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts). Browser storage can be cleared or evicted, so retain independent backups.

## Verification

```powershell
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Browser tests start an isolated hub on port `3101`, use a new temporary SQLite database, and disable cloud sync. They exercise menu/cart behavior, kitchen handoff and cash payment, hub outage drafts, management pages, and mobile navigation. Build before running them; they use the production frontend files in `dist`. Failures retain a screenshot and browser trace in `test-results`. The tests leave the normal development database untouched. Do not direct this suite at a live branch.

To use an already installed Google Chrome, set `PLAYWRIGHT_CHANNEL=chrome` in the test process environment. The browser suite blocks service workers for deterministic network tests; installed-PWA and actual device/printer checks remain part of the site pilot.

## Deployment scope

This implementation has not been certified for Sri Lankan tax, payroll, accounting, privacy, or fiscal receipt requirements. Tax/service-charge settings are configurable and default to zero; an authorized accountant must set the correct rules for the business. The master plan includes additional integrations and operational requirements beyond this initial implementation.

Operational deployment, backup/restore, security, and cloud details are in [docs/OPERATIONS.md](docs/OPERATIONS.md). Real demonstration photographs and their licenses are listed in [docs/ASSET-CREDITS.md](docs/ASSET-CREDITS.md).
