# Implementation status

This repository contains a working local evaluation version of DEMO HOTEL. It is not the complete production rollout described in the master plan.

## Implemented

- English desktop, tablet, and phone interface with the dark glass design.
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

## Required before a live single-branch pilot

- Select device or shared-hub topology. Device workspaces are independent and do not synchronize financial/stock records between devices.
- Independent backup storage and restore drills for the selected mode. Browser quota/persistence remains controlled by the platform; installed PWAs are not independent backups.
- Trusted HTTPS/DNS and, for hub mode, service supervision and a protected database directory.
- If Firebase replication is required: authorized server identity, receiver hosting, secure branch credentials, deployed access rules, and real end-to-end replication/recovery checks. The repository's rules and receiver code are not evidence that the actual project is connected.
- Actual printers, receipt layout, power/network outages, and physical device tests.
- Menu, recipes, opening stock, tax/charge configuration, staff permissions, and accountant review for the real business.

## Remaining from the full master plan

- Complete cross-branch transfer, receipt/discrepancy, and central command workflows across independent hubs.
- Consolidated cloud-backed head-office application; the current branch selector evaluates locally stored sample branches.
- Full double-entry accounting, accrual financial statements, supplier settlements, and closing-period controls. Customer credit collections and cash-flow statements are implemented.
- Advanced purchasing approvals, costing corrections, stock-count sessions, batch expiry policies, modifiers, and combo mapping.
- Controlled offline authorization leases, managed enrollment, automatic encrypted second-device backup, and standby promotion with receipt-series recovery.
- Safe standalone-to-hub migration, automatic device financial/stock journal merging, and central management across independent device workspaces. Photo copying does not provide those capabilities.
- Hardware print queues/cash drawer support, payment provider integrations, loyalty, attendance/payroll, catering, and online ordering as scoped.

The standalone workflow and its storage/backup limitations are documented in [DEVICE-WORKSPACE.md](DEVICE-WORKSPACE.md). This status describes implemented scope and remaining deployment work; it does not promise a completion date for the broader master plan.
