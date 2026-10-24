# Implementation status

This repository contains a working local evaluation version of DEMO HOTEL. It is not the complete production rollout described in the master plan.

## Implemented

- Vercel/Firebase shared POS, original-device baseline/journal uploads with durable retry, private POS PIN sessions and scoped device grants; requires real server credentials, `CLOUD_POS_PIN_HASH` and the deployment checks in [CLOUD-SYNC.md](CLOUD-SYNC.md).
- Authenticated cloud recovery after clearing browser data: reopen the same shared stock, sales and loan records with the ordinary POS PIN, without creating a public default PIN or overwriting an independent local database. Anonymous data reads/enrollment and obsolete writer grants are rejected.
- Shared **online owner** POS with atomic cloud stock checks and command replay. The same POS PIN opens the shop across its authorized devices, without a separate cloud account. Independent local staff PIN migration and automatic offline financial merging remain outside this feature.
- Separate network/cloud status dots, touch quantity/amount numpads, compatible recipe weight/volume conversions, and captured-cost wastage logs/exports with operating-estimate deductions.
- Safe manual PWA updates that flush drafts, stop on failed/pending storage and do not reload other active tabs automatically.
- Dialogs rendered above glass panels, including offline backup export/restore, with nested scroll locks and keyboard-aware mobile sizing.
- Backend-configured automatic shop entry with no separate cloud login, workspace picker or Cloud connection form in Settings; the original owner's pending journal is uploaded before switching its source to shared authority.

- English desktop, tablet, and phone interface with the dark glass design; tested touch layouts from 320 to 768 px and 140% app text, focus-zoom prevention and dialogs that scroll above the phone keyboard.
- PIN sessions, server-side staff roles, branch access, and audit records.
- Menu and recipe editing, cashier search, persistent device drafts, tables, kitchen tickets, and preparation status.
- Server-priced orders, cash/card/QR payment records, partial payments, refunds, receipts, and cash shifts.
- SQLite transactions, durable command replay protection, stock movements, batch production, purchasing, suppliers, customers, and expenses.
- Reports, CSV exports, verified local backups, and a Firebase Admin receiver with an outgoing event queue.
- Backend-only environment configuration. Firebase origin and private credentials are excluded from the browser API and Git.
- In-app Back across screens, dialogs, drawers and POS filters; per-device editable keyboard shortcuts and text-size controls.
- Products, unique barcodes/SKUs, branch stock counts, and category/product creation from the register.
- Shared held bills with version checks and atomic order consumption; customer credit ledgers and collections.
- Sales history with filters/CSV, income/expense cash-flow CSV and print/PDF, and day-end reconciliation exports.
- Per-device receipt widths, margins, offset and text size; honest hub printer discovery, individual LAN port checks, keyboard-scanner tests and optional WebHID access.
- Render/Vercel deployment templates with persistent storage and same-origin cookie authentication guidance.
- Standalone device workspaces on static HTTPS hosting, with atomic IndexedDB business writes, salted local PIN credentials, transaction replay protection, journal entries, and local role/branch checks.
- One-time device setup with an owner-selected PIN; optional sample data; persistent-storage request once, manual retry, browser usage/quota information, and no automatic business-record deletion.
- Owner-only password-encrypted worker backups, validation/preview before replacement, session exclusion/invalidation, new device identity on restore, and recoverable draft import.
- Local uploaded product photos, pre-save JPEG compression to at most 700,000 bytes, offline display, and authenticated same-origin hub copy retries without deleting original bytes.
- Recipe batch yields and packaging, weighted purchase/production cost, unit costs captured on confirmed order lines, daily/product profitability, and profit CSV export. Historical lines without saved cost are marked as estimates.
- Per-product low-stock thresholds with default 5, branch-specific quantities and recipe portions, and orange POS card outlines at the threshold.
- Fixed LKR discounts on individual product lines and the whole cart, with permission checks, held-bill persistence, receipt breakdown and preserved cost/stock quantities.
- Optional tables for counter and dine-in sales, register reset after a saved payment/receipt, and POS customer creation/selection for credit sales with item-level debt history and partial repayments.

## Required before a live single-branch pilot

- Select independent device, shared branch hub or shared online Firebase mode. Configure the shared shop's server credentials and private POS PIN once; all its authorized devices use the normal app address. Finish the original shop device's first upload before opening fresh devices. Independent local workspaces remain separate.
- Independent backup storage and restore drills for the selected mode. Browser quota/persistence remains controlled by the platform; installed PWAs are not independent backups.
- Trusted HTTPS/DNS and, for hub mode, service supervision and a protected database directory.
- If Firebase replication is required: authorized server identity, receiver hosting, secure branch credentials, deployed access rules, and real end-to-end replication/recovery checks. The repository's rules and receiver code are not evidence that the actual project is connected.
- Actual printers, receipt layout, power/network outages, and physical device tests.
- Menu, recipes, opening stock, tax/charge configuration, staff permissions, and accountant review for the real business.

## Remaining from the full master plan

- Complete cross-branch transfer, receipt/discrepancy, and central command workflows across independent hubs.
- Consolidation and inter-branch operational controls across independent cloud sources. The normal POS opens the configured shop rather than combining separate businesses.
- Full double-entry accounting, accrual financial statements, supplier settlements, and closing-period controls. Customer credit collections and cash-flow statements are implemented.
- Advanced purchasing approvals, costing corrections, stock-count sessions, batch expiry policies, modifiers, and combo mapping.
- Controlled offline authorization leases, managed enrollment, automatic encrypted second-device backup, and standby promotion with receipt-series recovery.
- Safe standalone-to-hub migration, automatic device financial/stock journal merging, and central management across independent device workspaces. Photo copying does not provide those capabilities.
- Raw ESC/POS/cash drawer/auto-cutter drivers and automatic kitchen/bar/counter KOT routing; physical printer integration is still required. Payment provider integrations, loyalty, attendance/payroll, catering and online ordering remain as scoped.

The standalone workflow and its storage/backup limitations are documented in [DEVICE-WORKSPACE.md](DEVICE-WORKSPACE.md). This status describes implemented scope and remaining deployment work; it does not promise a completion date for the broader master plan.
