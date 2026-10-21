# Customer handover and acceptance record

Complete a copy for each installation. Give the owner a readable copy of this record and the [owner quick start](OWNER-QUICK-START.md). Keep an agreed copy with the installer. An unchecked or untested item is not accepted. This record documents delivery; commercial, licensing, and support terms must be agreed separately.

## 1. Installation details

| Field | Agreed details |
| --- | --- |
| Business / customer name | |
| Owner / authorized representative | |
| Branch name and address | |
| Owner contact | |
| Installer / support contact | |
| Handover date | |
| App release / Git commit | |
| Trusted app URL | |
| Operating browser and profile | |
| Devices / operating systems | |
| Printer / paper width / scanner | |
| Data custodian and backup operator | |

Chosen operating mode (select one):

- [ ] **Standalone device workspace:** business records stay in this browser profile. Other phones/computers have independent records. No automatic shared sales, customer balances, or stock.
- [ ] **Shared branch hub:** cashier, waiter, and kitchen use one authoritative hub. Record the hub machine, protected database location, service/restart procedure, HTTPS address, and backup procedure in the installation notes below.

Installation notes / hub details: ______________________________

## 2. Documents and access delivered

- [ ] Agreed scope and quotation/order: included functions, exclusions, installation/training charges, any recurring charges, and payment terms.
- [ ] This completed handover and acceptance record, with unresolved items attached.
- [ ] [Owner quick start](OWNER-QUICK-START.md) and [sales/customer dues guide](POS-SALES.md), supplied in a format the owner can open.
- [ ] Backup/restore instructions for the chosen mode: [device guide](DEVICE-WORKSPACE.md) or [branch operations runbook](OPERATIONS.md).
- [ ] Device, printer, scanner, browser, URL, and service configuration inventory.
- [ ] Training attendance and support arrangements completed below.
- [ ] Account/ownership record: GitHub repository, hosting/domain/Firebase accounts if used, who controls each account, source-code/license rights agreed, and who may deploy updates. Transfer access through account invitations or another secure channel.
- [ ] Private Owner PIN and any required recovery/service credentials delivered separately to the authorized owner. No passwords, PINs, private keys, or backup passwords are written into this document or committed to GitHub.

## 3. Business setup checked with the owner

- [ ] Correct business name, branch, contact details, receipt header/footer, and currency.
- [ ] Live workspace selected; sample sales/catalog/stock have been excluded or explicitly reviewed. Do not erase an existing live workspace to remove demo data.
- [ ] Products, categories, barcodes, selling prices, purchase costs, and per-product low-stock levels checked. Blank new-product thresholds default to **5**; explicit zero is permitted.
- [ ] Ingredients, stock units, opening quantities/costs, recipe batch yields, portion quantities, and packaging checked with kitchen/store staff.
- [ ] Opening cash, customers and opening dues, suppliers, and existing balances entered and reconciled where applicable.
- [ ] Tax/service-charge settings and representative receipt calculations approved by the owner and their accountant.
- [ ] Private owner access and real staff roles tested. Public demo PINs are not being used for live operation.
- [ ] Device lock, access to downloaded backups, and responsibility for retaining customer information agreed.

## 4. Acceptance tests on the actual installation

Record **Pass**, **Fail**, or **Not tested** and evidence/date. Use an isolated test workspace or clearly identified test transactions with an agreed reconciliation procedure; do not quietly delete live records. Physical printer and outage tests cannot be replaced by a screenshot of the interface.

| Test | Expected result | Result / evidence |
| --- | --- | --- |
| Counter sale | Takeaway sale completes without a table. A dining table is required only for Dine-in. | |
| Successful checkout | Sale/payment is saved; when the receipt opens the register is clear for the next guest. Cancelling printing does not undo the sale. | |
| Cash and shift | Open shift, cash sale, refund/collection as permitted, and closing count reconcile. | |
| Card / QR entry | Record only a payment independently verified through the actual terminal/bank. The POS does not charge a card or verify a provider payment automatically. | |
| LKR discounts | Two LKR 350 units less LKR 50 line discount and LKR 20 cart discount give LKR 630 before applicable charges. Unauthorized roles cannot apply discounts. | |
| Stock | Confirmation consumes the correct quantity once; holding a bill does not consume stock. Check purchase receiving and a production batch where used. | |
| Low stock | Set one product's threshold; at or below it the POS card has a thin orange outline. Check another product independently and the default 5. | |
| Credit customer | Choose/create a customer in POS; credit sale retains customer details, bill items, and outstanding balance in Customers & dues. | |
| Partial repayment | A LKR 1,000 balance less a LKR 300 collection leaves LKR 700, with the collection date/method recorded. The original sale is not counted twice. | |
| Reports | Sales, dues, expenses, cash-flow, and profit totals agree with the test records; required CSV and print/PDF exports open correctly. | |
| Food cost | Check one recipe's units/yield and one resale item's cost. Later cost changes do not rewrite captured costs on old sales; estimated historical costs are identified. | |
| Printer / scanner | Print on the actual paper width; verify centering, margins, legibility, reprint, and scanner input. Test a disconnected printer and recover without duplicating a sale. | |
| Offline / restart | After initial caching, restart the same browser/profile with internet disabled. Device mode saves and reloads a test bill; hub mode works through an internet outage while the hub/LAN remain available. | |
| Device backup / restore | Export, copy off-device, and restore a device backup into an empty spare browser profile. Sign in with a backed-up PIN; compare sales, stock, customer dues, photos, and open bills. Do not overwrite the trading device for this drill. | |
| Hub backup / restore, if used | Restore a full SQLite backup into an isolated hub using the runbook and compare business totals. Keep it separate from the live branch. | |
| Access and settings | Test staff permissions, receipt dimensions, text size, shortcuts, and agreed phone/desktop devices. | |

## 5. Backup and recovery responsibility

| Field | Agreed details |
| --- | --- |
| Responsible person / substitute | |
| Backup schedule, including day-end | |
| Independent storage location | |
| Number / age of copies retained | |
| Separate password custody method | |
| Last successful restore drill / next drill | |
| Recovery contact and procedure | |

For device mode, copy encrypted `.hotelbackup` files away from the operating device. The password cannot be recovered by the app. A download-request timestamp is not proof that a safe external copy exists. Do not record the password here.

## 6. Training and support

| Training topic | Attendee / role | Date / demonstrated successfully |
| --- | --- | --- |
| Sign-in, shift opening, sales, discounts, receipts | | |
| Credit customers, partial collections, and refunds | | |
| Products, stock, recipes, purchases, and low stock | | |
| Reports, expenses, day-end reconciliation | | |
| Backup, restore drill, and outage recovery | | |

Support contact: ____________________  Hours / time zone: ____________________

Agreed response arrangements: ____________________

Included support period / charges / exclusions: ____________________

Who approves updates and schedules a backup before an update: ____________________

Record the actual agreement; no response time, warranty, or free maintenance is implied by a blank field.

## 7. Limitations acknowledged and outstanding work

- Standalone devices do not automatically merge financial records, customer dues, or stock with other devices or Firebase. Restoring a backup replaces data; it is not a merge. Use a shared hub when devices need the same live records.
- Firebase receiver code and rules do not mean a live project is connected. Record any separately configured cloud deployment and its verification; otherwise mark cloud replication **not configured**. Photo copying is not a full financial backup.
- Browser quota, device failure, clearing site data, deleting/changing profiles, and changing the app origin can affect device records. PWA installation does not remove these risks. The app has no automatic business-record deletion, but it cannot override browser storage limits.
- Printing uses browser/driver support. Printer discovery or a responding network port does not prove paper printed. Payment entries do not constitute payment-provider integration.
- Profit estimates depend on recorded costs, recipes, stock, and expenses. The app does not provide full statutory accounts, payroll, or a certified tax-compliance system. See [implementation status](BUILD-STATUS.md) for remaining scope.

| Outstanding / failed / untested item | Owner of action | Target date | Workaround / agreed consequence |
| --- | --- | --- | --- |
| | | | |
| | | | |

Decision (select one):

- [ ] Accepted for the explicitly recorded scope after the required tests passed.
- [ ] Limited pilot only; deferred items and permitted use are recorded above.
- [ ] Not accepted; failed/untested requirements need resolution before live use.

Customer representative name / signature / date: ______________________________

Installer name / signature / date: ______________________________

Signing does not mark an untested or failed item as passed. Attach additional pages if needed; give both parties the same completed version.
