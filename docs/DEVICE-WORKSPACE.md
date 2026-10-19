# Standalone device workspace

A device workspace stores confirmed POS records in IndexedDB inside the current browser profile. It runs without a paid backend and can continue transactions offline after the app files have been cached. It is a separate mode from the shared SQLite branch hub.

## First setup

1. Open the app through its trusted HTTPS address while online. Use the same address and browser/profile for future work.
2. Choose **Set up this device**, enter the business and owner names, and create a private **6–12 digit owner PIN**. Confirm the PIN. Sample menu/stock data is optional and is off by default.
3. Wait for setup to finish. The setup marker commits with the initial records and owner credential, so a failed setup is not reported as complete. Existing records are not silently replaced or reseeded.
4. Review products, costs, stock, recipes, receipt details, staff, and opening balances. Open a cash shift before accepting cash.
5. Allow the initial app cache to finish, then test reopening and billing with internet disabled. Use **Install app** in Settings when supported, or the browser's own install/add-to-home-screen menu.

Use the owner PIN created here to sign in. Public demo-hub PIN `1234` is not the default for a standalone workspace. There is no separate administrator URL; the Owner role opens the management pages.

The app requests persistent browser storage once after setup, where supported. Refusal does not block billing or trigger the same automatic request on every launch. Settings provides a manual retry and the reported persistence/usage information. Setup does not repeat while the committed workspace remains saved.

## What stays on the device

The local database contains the catalog, uploaded photo bytes, staff credential hashes, orders, payments, refunds, stock, purchases, production, customers, held bills, shifts, expenses, settings, command replay records, and a change journal. Confirmed mutations and journal entries commit atomically. Retrying an accepted command does not create a second sale. Tabs of the same origin/profile use the same database and receive change notifications.

PINs use salted PBKDF2-SHA256 hashes. Device sessions expire and are separate from hub cookies. The working database is not encrypted by the application; protect the device account and use device encryption. Downloaded backups are encrypted.

Device mode does not need `/api/session` or `/api/health` to work. A static Vercel deployment can use it even when those backend paths return 404. Choosing **Use branch hub instead** switches to server-backed mode; it does not merge or migrate the device database.

## Storage and keeping records safe

There is no application-imposed total-record limit and no automatic deletion of old business records. Browsers still set an origin quota based on the browser, storage pressure, and device. The app cannot reserve the whole disk, prevent the operating system from filling it, or override a denied persistence request.

Settings displays reported browser usage/quota, persistence state, record/journal counts, and the last backup download request. A full or unavailable database produces a save error rather than a successful bill acknowledgement. Free storage and retry after checking whether the previous command was accepted. Avoid private/incognito browsing for permanent records.

PWA installation retains browser-managed storage rather than downloading an ordinary database file to a chosen folder. Removing a browser/profile, clearing site data, changing the origin/domain, device loss, browser eviction, or disk failure can make records unavailable. Installation and persistent-storage permission do not replace an independent backup.

## Encrypted backup and restore

Only the Owner can export or replace an existing workspace through **Settings → Device storage & backups**.

1. Export a backup, choose a strong password of at least ten characters, and save the downloaded `.hotelbackup` file.
2. Copy the file to another device or independent storage. Keep its password separately; the app cannot recover a forgotten backup password.
3. Keep several dated restore points, especially after closing shifts and before upgrades. “Last backup download requested” means a browser download was initiated, not that an external copy was verified.
4. Periodically verify a backup on an empty spare browser/profile using **Restore device backup**. Review totals, stock, open bills, staff access, photos, and restored drafts.

Serialization, compression where supported, and AES-256-GCM encryption run in a worker. Password derivation uses PBKDF2-SHA256 and a random salt; authenticated encryption detects wrong passwords or damaged files before replacement. Full business records, credential hashes, journal, command replay records, and device drafts are included. Active sessions are excluded.

Restore decrypts and validates the backup and displays a preview. Replacing a populated workspace requires owner access, explicit replacement confirmation, and the current business name. Business database replacement is atomic. Drafts use a durable recovery marker so an interrupted secondary draft import can be retried. Restored sessions are invalidated; sign in using a PIN contained in the backup.

Restore generates a **new device identity** while retaining the business/workspace identity and historical receipts. New receipts therefore do not reuse the source device's receipt series. A restored copy is not a safe simultaneous second cashier for the same inventory: there is no transaction merge.

## Product photos

In Products or the menu editor, enter a safe HTTPS photo URL, or choose **Upload product photo**. JPEG, PNG, and WebP are accepted; the source must be no larger than 25 MB and at most 50 million pixels. Uploads become JPEG, with a maximum 1,600-pixel edge, compressed to **at most 700,000 bytes**, leaving the base64 JSON request below 1 MB. Compression and local saving also work offline.

Device uploads retain their bytes in IndexedDB and encrypted backups. They remain usable without internet. External URL images depend on the other site; their continued availability and offline display are not guaranteed.

When online, the app checks for an existing authenticated Owner/Manager session on a same-origin hub and retries small batches of pending photo copies. It never submits the local owner PIN to log in automatically. A matching backend acknowledgement is required before marking a photo copied; local bytes remain saved. Without the backend/session, photos remain queued. Firebase replication additionally requires the hub and trusted receiver to have real server credentials. Internet connectivity alone does not prove a cloud backup.

## Food costs and profit

For resale items, record purchase/unit cost and selling price. Purchase receiving updates weighted average stock cost. Production batches combine the ingredients' recorded costs into prepared-stock cost, weighted with portions already in stock.

For cooked dishes, set **Recipe yield (portions)** and enter quantities for the whole batch, including packaging. Use inventory units: enter `2` for 2 kg when the ingredient unit is kg, rather than `2000` grams. The editor divides batch quantities by yield once and stores canonical per-portion consumption.

For example, LKR 10,000 of ingredients yielding 50 portions gives LKR 200 food cost per portion. A selling price of LKR 350 gives LKR 150 gross profit per portion before discounts, tax/service treatment, waste, and operating expenses. Record rice, coconut, meat, fish, vegetables, eggs, and packaging in inventory so their costs contribute to the recipe. Keep quantities/yields consistent with kitchen practice.

Order confirmation saves each line's applicable unit cost. Later purchase-price/recipe changes do not rewrite that cost. Direct-recipe items use ingredients per portion, prepared/resale items use stock cost, and untracked items use manual cost. Historical lines without captured cost use the available current basis and are marked as estimates. Missing cost configuration is disclosed.

Overview, Finance, and Reports include date filters, daily/product profitability, and CSV download. The calculation uses:

- Net sales from confirmed bills, including unpaid/credit bills, after discounts/refunds and excluding tax/service charges.
- Gross profit: net sales less captured or explicitly estimated cost of sales.
- Operating estimate: gross profit less recorded operating expenses and cancelled food cost. Stock/ingredient purchase expense categories are excluded to avoid deducting inventory costs twice.
- Credit collections do not count as a second sale. Refunds restate the original bill date; consumed food cost remains because refunds/cancellations do not automatically restock cooked food.

The operating estimate excludes unrecorded overheads and other stock write-offs. It is not a complete accounting profit statement. Cash-flow reports measure receipts/outflows and can differ from confirmed-bill profitability. Owners, managers, and accountants can view costs; other roles do not receive captured order-line costs.

## Several devices, branches, and Firebase

Separate browsers/devices have separate workspaces, PIN stores, stock balances, and receipts. Standalone mode has no financial journal upload/merge, automatic inventory reconciliation, or central device dashboard. Restoring a backup replaces records; it does not combine two sets of sales.

For cashier, waiter, and kitchen devices sharing a branch, connect them to one authoritative Node branch hub over LAN/Wi-Fi. That hub continues during internet outages while the LAN and hub work. See the [operations runbook](OPERATIONS.md).

Firebase needs a separately hosted trusted receiver, Firebase Admin credentials, and branch authorization. Receiver code and default-deny rules are included, but they do not deploy or authenticate the real project. Existing hub replication is one-way; full business recovery from Firebase and bidirectional multi-branch merges are not implemented.
