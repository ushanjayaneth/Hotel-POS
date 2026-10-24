# Standalone device workspace

A device workspace stores confirmed POS records in IndexedDB inside the current browser profile. It runs without a paid backend and can continue transactions offline after the app files have been cached. It is a separate mode from the shared SQLite branch hub.

## First setup

1. Open the trusted HTTPS address with `/?local=1` while online to deliberately create an independent offline workspace. The normal configured app address opens the shared cloud workspace instead. Use the same browser/profile for later local work.
2. Choose **Set up this device**, enter the business and owner names, and create a private **6–12 digit owner PIN**. Confirm the PIN. Sample menu/stock data is optional and is off by default.
3. Wait for setup to finish. The setup marker commits with the initial records and owner credential, so a failed setup is not reported as complete. Existing records are not silently replaced or reseeded.
4. Review products, costs, stock, recipes, receipt details, staff, and opening balances. Open a cash shift before accepting cash.
5. Allow the initial app cache to finish, then test reopening and billing with internet disabled. Use **Install app** in Settings when supported, or the browser's own install/add-to-home-screen menu.

Use the owner PIN created here to sign in. Public demo-hub PIN `1234` is not the default for a standalone workspace. There is no separate administrator URL; the Owner role opens the management pages.

The app requests persistent browser storage once after a real workspace opens, where supported. The attempt is saved atomically, so concurrent tabs or later launches do not repeatedly request a refused permission. Already persistent origins are not prompted again. An unsupported browser does not consume the first supported attempt. Settings provides a manual retry and the reported persistence/usage information. Setup does not repeat while the committed workspace remains saved.

## What stays on the device

The local database contains the catalog, uploaded photo bytes, staff credential hashes, orders, payments, refunds, stock, purchases, production, customers, held bills, shifts, expenses, settings, command replay records, and a change journal. Confirmed mutations and journal entries commit atomically. Retrying an accepted command does not create a second sale. Tabs of the same origin/profile use the same database and receive change notifications.

PINs use salted PBKDF2-SHA256 hashes. Device sessions expire and are separate from hub cookies. The working database is not encrypted by the application; protect the device account and use device encryption. Downloaded backups are encrypted.

Device mode does not need `/api/session` or `/api/health` to work. A static Vercel deployment can use it even when those backend paths return 404. Choosing **Use branch hub instead** switches to server-backed mode; it does not merge or migrate the device database.

## Storage and keeping records safe

There is no application-imposed total-record limit and no automatic deletion of old business records. Browsers still set an origin quota based on the browser, storage pressure, and device. The app cannot reserve the whole disk, prevent the operating system from filling it, or override a denied persistence request.

Settings displays reported browser usage/quota, persistence state, record/journal counts, and the last backup download request. A full or unavailable database produces a save error rather than a successful bill acknowledgement. Free storage and retry after checking whether the previous command was accepted. Avoid private/incognito browsing for permanent records.

PWA installation retains browser-managed storage rather than downloading an ordinary database file to a chosen folder. Removing a browser/profile, clearing site data, changing the origin/domain, device loss, browser eviction, or disk failure can make records unavailable. Clearing ordinary browsing history and clearing site data are different actions; installing the PWA does not make its site data immune to deletion. Persistent storage protects against automatic browser eviction when granted. It cannot prevent a user from clearing site data, formatting the device or removing the browser profile. Neither installation nor persistence replaces an independent backup.

## Encrypted backup and restore

Only the Owner can export or replace an existing workspace through **Settings → Device storage & backups**.

1. Export a backup, choose a strong password of at least ten characters, and save the downloaded `.hotelbackup` file.
2. Copy the file to another device or independent storage. Keep its password separately; the app cannot recover a forgotten backup password.
3. Keep several dated restore points, especially after closing shifts and before upgrades. “Last backup download requested” means a browser download was initiated, not that an external copy was verified.
4. Periodically verify a backup on an empty spare browser/profile using **Restore device backup**. Review totals, stock, open bills, staff access, photos, and restored drafts.

Serialization, compression where supported, and AES-256-GCM encryption run in a worker. Password derivation uses PBKDF2-SHA256 with 310,000 iterations and a random salt; authenticated encryption detects wrong passwords or damaged files before replacement. Full local business records, uploaded photo bytes, credential hashes, journal, command replay records, and device drafts are included. Active sessions and cloud connection grants are excluded. A `.hotelbackup` is a snapshot of the independent local database at export time; it is not an export of a later shared cloud workspace.

Restore decrypts and validates the backup and displays a preview. Replacing a populated workspace requires owner access, explicit replacement confirmation, and the current business name. Business database replacement is atomic. Drafts use a durable recovery marker so an interrupted secondary draft import can be retried. Restored sessions are invalidated; sign in using a PIN contained in the backup.

Restore generates a **new device identity** while retaining the business/workspace identity and historical receipts. New receipts therefore do not reuse the source device's receipt series. A restored copy is not a safe simultaneous second cashier for the same inventory: there is no transaction merge.

## Product photos

In Products or the menu editor, enter a safe HTTPS photo URL, or choose **Upload product photo**. JPEG, PNG, and WebP are accepted; the source must be no larger than 25 MB and at most 50 million pixels. Uploads become JPEG, with a maximum 1,600-pixel edge, compressed to **at most 700,000 bytes**, leaving the base64 JSON request below 1 MB. Compression and local saving also work offline.

Device uploads retain their bytes in IndexedDB and encrypted backups. They remain usable without internet. External URL images depend on the other site; their continued availability and offline display are not guaranteed.

When online, the app checks for an existing authenticated Owner/Manager session on a same-origin hub and retries small batches of pending photo copies. It never submits the local owner PIN to log in automatically. A matching backend acknowledgement is required before marking a photo copied; local bytes remain saved. Without the backend/session, photos remain queued. Firebase replication additionally requires the hub and trusted receiver to have real server credentials. Internet connectivity alone does not prove a cloud backup.

## Food costs and profit

For resale items, record purchase/unit cost and selling price. Purchase receiving updates weighted average stock cost. Production batches combine the ingredients' recorded costs into prepared-stock cost, weighted with portions already in stock.

For cooked dishes, set **Recipe yield (portions)** and enter quantities for the whole batch, including packaging. Select a compatible unit beside each ingredient: for stock held in kg, either `2 kg` or `2000 g` is valid. The editor converts to the inventory unit and divides batch quantities by yield once. It supports mass and volume conversions without guessing conversions between weight and volume.

For example, LKR 10,000 of ingredients yielding 50 portions gives LKR 200 food cost per portion. A selling price of LKR 350 gives LKR 150 gross profit per portion before discounts, tax/service treatment, waste, and operating expenses. Record rice, coconut, meat, fish, vegetables, eggs, and packaging in inventory so their costs contribute to the recipe. Keep quantities/yields consistent with kitchen practice.

Order confirmation saves each line's applicable unit cost. Later purchase-price/recipe changes do not rewrite that cost. Direct-recipe items use ingredients per portion, prepared/resale items use stock cost, and untracked items use manual cost. Historical lines without captured cost use the available current basis and are marked as estimates. Missing cost configuration is disclosed.

Overview, Finance, and Reports include date filters, daily/product profitability, and CSV download. The calculation uses:

- Net sales from confirmed bills, including unpaid/credit bills, after discounts/refunds and excluding tax/service charges.
- Gross profit: net sales less captured or explicitly estimated cost of sales.
- Operating estimate: gross profit less recorded operating expenses, cancelled food cost and recorded wastage cost. Stock/ingredient purchase expense categories are excluded to avoid deducting inventory costs twice.
- Credit collections do not count as a second sale. Refunds restate the original bill date; consumed food cost remains because refunds/cancellations do not automatically restock cooked food.

Use **Inventory → Wastage** to record spoiled, burnt, expired or leftover stock with a reason. The saved movement deducts stock and records its cost without creating a cash expense. The operating estimate excludes unrecorded overheads and write-offs not entered in the system. It is not a complete accounting profit statement. Cash-flow reports measure receipts/outflows and can differ from confirmed-bill profitability. Owners, managers, and accountants can view costs; other roles do not receive captured order-line costs.

## Several devices, branches, and Firebase

Separate independent device workspaces have separate PIN stores, stock balances and receipts. Opening the same public website on several devices does not itself connect their local databases. Restoring a backup replaces records; it does not combine two sets of sales.

The [cloud connection guide](CLOUD-SYNC.md) explains the Vercel/Firebase setup and the operating modes:

- **Automatic cloud entry:** Firebase is configured on the backend; there is no separate Cloud connection form, admin login or workspace picker. Open the normal app address on the original shop device and use the ordinary POS PIN. If there is no existing cloud business, its authenticated local owner's consistent baseline and pending journal upload before that source becomes shared. Keep the app open and connected until the transfer finishes. Unuploaded offline sales are not protected by cloud recovery.
- **Shared online POS:** open the normal app address on every authorized phone, tablet and computer, including the original till, and enter the same POS PIN when requested. The shop opens automatically. Older explicit `/?shared=SOURCE_ID` links remain compatible. Confirmed transactions use the same authoritative cloud stock and customer balances. Internet is required to confirm them; new offline work remains a draft on its own device. The single shared owner PIN does not migrate separate local staff PINs/roles into the cloud.
- **Recovery:** after browser-data loss or on a replacement device, open the normal app address and enter the POS PIN. Its authorized records load automatically from the cloud. The app does not expose business records to a new anonymous browser. Local staff PINs, uploaded local photo bytes and unfinished drafts are not in the cloud projection; use the encrypted local backup for those parts of an independent device workspace.

There is no promise that a phone lost before uploading its offline transactions can recover those transactions. Cloud records remain dependent on the real Firebase project, its credentials, access, quotas and retention. Keep separate dated backups and test recovery before handover.

For cashier, waiter, and kitchen devices sharing a branch, connect them to one authoritative Node branch hub over LAN/Wi-Fi. That hub continues during internet outages while the LAN and hub work. See the [operations runbook](OPERATIONS.md).

The Vercel `/api/cloud` function uses server-only Firebase Admin credentials; it does not require a paid Render service. Configure and verify the actual project as described in the cloud guide. Existing branch-hub receiver replication is a separate feature and remains one-way. Automatic offline merging of several independent financial journals is not supported.

Browser references: [persistent storage](https://web.dev/articles/persistent-storage) and [storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).
