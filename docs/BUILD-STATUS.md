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

## Required before a live single-branch pilot

- Authorized Firebase server identity, receiver hosting, secure branch credentials, and deployed database access rules.
- End-to-end synchronization and restoration against the actual Firebase project.
- Trusted branch HTTPS/DNS, service supervision, independent backup storage, and recovery drills.
- Actual printers, receipt layout, power/network outages, and physical device tests.
- Menu, recipes, opening stock, tax/charge configuration, staff permissions, and accountant review for the real business.

## Remaining from the full master plan

- Complete cross-branch transfer, receipt/discrepancy, and central command workflows across independent hubs.
- Consolidated cloud-backed head-office application; the current branch selector evaluates locally stored sample branches.
- Full double-entry accounting, accrual financial statements, supplier settlements, and closing-period controls. Customer credit collections and cash-flow statements are implemented.
- Advanced purchasing approvals, costing corrections, stock-count sessions, batch expiry policies, modifiers, and combo mapping.
- Controlled offline authorization leases, managed enrollment, automatic encrypted second-device backup, and standby promotion with receipt-series recovery.
- Hardware print queues/cash drawer support, payment provider integrations, loyalty, attendance/payroll, catering, and online ordering as scoped.

The original planning allowance was 18–28 weeks for the complete multi-branch scope with two experienced developers plus QA and business input. A supervised single-branch pilot may be planned in a narrower 2–4 week preparation window, subject to the outstanding configuration, hardware, and testing. These are planning ranges, not a delivery commitment.
