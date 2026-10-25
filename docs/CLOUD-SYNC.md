# Firebase connection and shared POS

The normal app address uses one backend-configured Firebase Realtime Database for the shop. Open that address on each authorized phone, tablet or computer and enter the ordinary **POS PIN** when requested. The app opens the shop automatically. There is no separate cloud admin login, workspace picker, or Cloud connection form in Settings.

The Firebase URL and Admin credentials stay on the server. A signed, HttpOnly session authorizes cloud requests after PIN verification. A successful online PIN entry also saves a salted PBKDF2 credential in that device's private local database for offline sign-in. This local credential is never uploaded to Firebase or included in business records. Direct anonymous database reads and writes remain denied. An internet connection or a configured flag alone does not prove a successful database write.

## Configure Vercel once

1. In the intended Firebase project, open **Project settings → Service accounts → Firebase Admin SDK → Generate new private key**. Keep that downloaded JSON outside Git and deliver credentials privately.
2. From the project directory run:

   ```powershell
   node scripts/create-cloud-config.mjs "C:\private\service-account.json" "https://YOUR-DATABASE.firebaseio.com/"
   ```

   The helper generates a private eight-digit POS PIN. To retain an existing private PIN, provide it through the helper process's `POS_SETUP_PIN` environment variable using a private prompt or secret manager. It must contain 6–16 digits. Do not pass a PIN in command arguments, write it into shell history, or use the public four-digit demo PIN.

3. The helper writes four environment-value files inside ignored `artifacts/cloud-config/<timestamp>`: `FIREBASE_DATABASE_URL.txt`, `FIREBASE_SERVICE_ACCOUNT_JSON.txt`, `CLOUD_POS_PIN_HASH.txt`, and `CLOUD_SESSION_SECRET.txt`. Copy each complete value into **Vercel → Project → Settings → Environment Variables → Production**, using its filename without `.txt` as the name. Keep these variables server-only; never use `VITE_*` prefixes.
4. The additional **`POS-PIN.txt`** is a private owner handover file. It is not an environment variable and must not be uploaded to GitHub. The helper prints the output directory, never the PIN or private credentials.
5. Redeploy the latest commit. The root `vercel.json` deploys `api/cloud.ts` with Vite; no separate Render service or API rewrite is needed. Remove old rewrites that forward `/api/cloud` elsewhere.
6. Keep direct browser access to Realtime Database denied. The repository's `firebase/database.rules.json` sets `.read` and `.write` to false. Deploy these rules to the intended project. The private Admin SDK service account authorizes backend access independently.
7. Check `/api/cloud?action=status`: it must show `configured: true` and `posPinConfigured: true`. Only configuration state and missing variable names are exposed. Complete the shop/phone acceptance exercise below to verify actual Firebase access.

The older three-argument helper form, `OWNER_EMAIL SERVICE_ACCOUNT_FILE DATABASE_URL`, remains supported for legacy account compatibility. It adds two optional legacy environment-value files and `OWNER-LOGIN.txt`; the ordinary POS still uses `POS-PIN.txt`. Existing optional `CLOUD_OWNER_EMAIL` and `CLOUD_OWNER_PASSWORD_HASH` values do not require another login screen. Do not regenerate a working configuration just to add PIN sign-in: add the PIN hash while preserving the established service account, signing secret and any compatibility credentials.

`CLOUD_TENANT_ID` optionally selects an isolated database namespace. Use a stable letters/digits/underscore/hyphen name. Changing the namespace points at a different set of records. Changing the POS PIN hash, a configured legacy credential or signing secret invalidates existing cloud sessions and device grants; authorized devices must sign in again.

## First transfer and everyday use

Use the **original shop device first** when its existing records have not reached Firebase. Keep an encrypted external backup of that local workspace before transferring live business records.

- Open the normal app address and enter the POS PIN. The original local owner's consistent baseline and pending journal finish uploading before that source becomes the shared authority. Its original local database is retained.
- Keep the app open and connected until the transfer finishes. An interrupted initial upload is preserved for resuming; another device does not replace it with an empty business.
- The verified POS PIN also authorizes that device's first transfer when its earlier local session has expired. No second sign-in or pairing form is required; the original local records remain intact.
- Open the same normal app address on the other authorized devices and use the same POS PIN. They read the existing cloud business rather than uploading their local copies over its stock or loans.
- If there are no local or cloud records, PIN-authenticated setup creates one empty business with a Main branch and General category. Simultaneous first launches converge on that one business. No sample sales or public default PIN are created.

The app remembers the shop internally; normal use does not require adding or selecting a cloud workspace. Older explicit shared links remain compatible. If conflicting independent historical sources exist, they must be resolved without overwriting or merging their financial records silently.

`/?local=1` deliberately opens the independent original copy for backup/recovery. It is not another live cashier for shared stock. After the switch, new independent local sales do not automatically merge into the cloud authority. Uploaded local photo bytes, local staff credentials and device drafts stay in the original local backup.

## Several devices using the same records

Orders, payments, loans, partial collections, stock, recipes, production, purchases and supported management actions use the same validated operations on the backend. Firebase compare-and-swap commits each complete transaction. Stock conflicts roll back, and an identical retried command returns its original result rather than creating another sale.

The shop's ordinary POS PIN gives its authorized owner access from their devices. Separate cloud staff PIN/role migration is outside this feature. Legacy independent uploads are rejected after their source becomes shared, so an old local snapshot cannot overwrite current shared balances.

Open and sign in on each device once while online to prepare its separate offline cache. Afterwards it can confirm bills, receive payments, print/reprint receipts, manage customer loans and collections, add products/photos, change prices and stock, record expenses, and view or download reports without internet. Categories, recipes, production, purchases, wastage and business settings use the same local transaction queue. Installing the PWA is optional; a supported browser at the same address can perform these operations.

Use the same shop **Staff PIN** for online and offline sign-in. After it has been verified online on that browser/profile, logging out retains its local PIN hash, cached business records and unsynced transactions. The PIN can unlock the prepared device offline after logout or reload. A remembered server cookie alone does not prepare an offline PIN; a device that has not completed this online PIN entry must do so once. Ten unsuccessful offline PIN attempts temporarily block further attempts for 15 minutes. A successful online PIN entry refreshes the saved credential and clears that local lock.

Every action and its upload entry commit together in that device's IndexedDB database. The app uploads queued actions in order when it is open and can reach Firebase. Receipt IDs and captured prices stay unchanged. A lost acknowledgement retries the same transaction ID and cannot create another sale or payment. Pending records are never replaced by a newer cloud snapshot. After upload, the other devices refresh their stock, loans, bills and reports automatically. An expired server session requires the same POS PIN before uploads resume; queued records remain saved.

Online stock checks still reject two devices selling the same final unit. Several disconnected devices cannot see one another's stock changes: when genuine offline sales exceed the remaining stock, the app preserves the completed bills, records the resulting shortage and adds a review warning. Financial rows merge as transactions and deltas. Concurrent catalog edits merge per field and retain conflict details in the audit log. A payment is saved before printing, so a printer failure does not cancel it. Printing uses the browser/operating-system print service; raw ESC/POS, automatic cutters and cash-drawer drivers remain separate hardware work.

For product photos, use **Take photo** for the device camera, **Choose photo** for JPEG/PNG/WebP files, or enter an HTTPS image link. Camera and file images are optimized to JPEG at most 450,000 bytes with a maximum 1,600-pixel edge. This preserves useful product detail without promising lossless compression. Photos save on the device while offline and upload automatically with its queued changes after reconnecting.

Uploaded photos are stored privately in Firebase separately from bill data. Authorized devices download each photo on demand and retain it for offline use; routine stock/report refreshes do not download the entire photo library again. A photo that has not yet been downloaded cannot appear on a disconnected replacement device. Older photos that remain only in an independent original workspace are not implied to be uploaded by migrating its business records.

The shared POS checks for server changes while visible. The network and cloud dots report different states: **Online/Offline** describes this device's network; the cloud indicator reports actual recent server contact and whether uploads or connection failures remain. A green network dot alone is not proof that a sale reached Firebase.

## Recovery after browser clearing or device loss

1. Open the normal trusted app address while online on the replacement device or cleared browser.
2. Enter the same private POS PIN when requested. Clearing site data removes its session, offline PIN credential and cache; private shop records are not returned to an anonymous browser. The new online PIN entry prepares offline sign-in again.
3. The app opens the shop automatically and loads its authorized cloud stock, sales, loans and reports. No separate admin account or workspace selection is required.
4. Compare the latest sale, stock and customer balance with the expected records before resuming work.

Cloud recovery covers records and photos the server actually acknowledged. A sale or photo still waiting to upload, or an unfinished draft on a lost phone, cannot be recovered from Firebase. Logging out preserves queued changes; clearing site data or removing the operating browser profile can destroy them. The cloud projection excludes local staff credentials, offline PIN hashes, active sessions and the original independent command/journal store. Reopening shared POS does not reconstruct those parts of an independent device database.

Keep verified `.hotelbackup` files for complete local recovery. A local backup captures its original workspace at export time; it does not include later changes made only in the shared cloud business. Firebase remains subject to administrative deletion, account access, quotas and service availability. Do not promise absolute zero data loss or unlimited retention.

## Browser storage and external backups

The app requests persistent storage once after a real workspace opens where supported. It remembers a refused request; **Settings → Device storage & backups** provides a manual retry, usage/quota and permission state. The browser decides whether to grant persistence.

Granted persistence protects against automatic storage-pressure eviction. It does not prevent deliberate site-data deletion, profile removal, formatting or device loss. An installed PWA still uses browser-managed site storage rather than a second protected database. Clearing ordinary browsing history and clearing site data are different operations. See [Chrome's persistent storage guidance](https://web.dev/articles/persistent-storage).

For an independent local workspace, the Owner can export an AES-256-GCM password-protected `.hotelbackup` containing records, uploaded photos, credential hashes, journal and drafts. Keep dated copies outside the operating browser, keep passwords separately, and test restoration on an empty spare profile. Shared Settings does not present local backup replacement as a cloud restore. Arrange independent Firebase backups according to the agreed recovery plan, including both business data and the separate private photo storage.

## Acceptance before handover

Demonstrate a sale and partial loan collection on the shop device, then verify updated stock, loan balance and reports on a second phone. With both devices online, attempt to sell the final stock unit simultaneously and confirm one is rejected. Then disconnect one prepared device, log out, reload and sign in with the same Staff PIN. Add a product using the camera or file picker, change price/cost/stock, sell and print, record an expense and collection, and download reports. Reconnect and verify those exact records and amounts on the other device. Drop one acknowledgement and confirm no duplicate bill or payment appears. Separately test a cleared spare browser and an interrupted first upload; never clear the operating device while changes remain pending.

Customer Loan checkout can record cash paid now and the remaining loan together in one replay-safe payment command. Only the cash part changes the drawer; only the credit part enters the customer's loan ledger. Prepared offline devices retain both parts until acknowledgement. Later partial collections subtract only the amount received. Collection forms start blank and show a remaining-balance preview; full repayment requires explicit entry or **Pay in full**.

Profit reports distinguish bill-basis profitability from red customer receivables. Loan balances come from the selected branch ledger through the report end date, including older loans; period repayments are shown separately and do not create another sale or profit. Advances do not offset another customer's outstanding debt. CSV exports retain the same distinction.

Keep separate backups and monitor the actual Firebase/Vercel quotas. No plan provides unlimited storage, bandwidth, function invocations or uptime.

References: [Vercel Node functions](https://vercel.com/docs/functions/runtimes/node-js), [Firebase Admin setup](https://firebase.google.com/docs/admin/setup), [Admin Realtime Database access](https://firebase.google.com/docs/database/admin/start).
