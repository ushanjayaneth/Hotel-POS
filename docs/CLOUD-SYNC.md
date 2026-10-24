# Cloud connection, owner live view and shared POS

This feature adds a Vercel Node function at `/api/cloud`, Firebase Admin persistence, automatic device uploads and an owner dashboard at `/?cloud=1`. It does not require the separate Render receiver. The server credentials must be configured before the public deployment can connect to the actual database. A successful local test is not proof of a connected production Firebase project.

## Configure Vercel once

1. In the intended Firebase project, open **Project settings → Service accounts → Firebase Admin SDK → Generate new private key**. Keep that downloaded JSON outside Git. Do not send its private key in chat or put it in a `VITE_*` variable.
2. From the project directory run:

   ```powershell
   node scripts/create-cloud-config.mjs "OWNER_EMAIL" "C:\private\service-account.json" "https://YOUR-DATABASE.firebaseio.com/"
   ```

3. The helper creates five environment-value files and a login file in an ignored `artifacts/cloud-config/<timestamp>` directory: `FIREBASE_DATABASE_URL`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `CLOUD_OWNER_EMAIL`, `CLOUD_OWNER_PASSWORD_HASH`, and `CLOUD_SESSION_SECRET`, each with `.txt` extension. There are **five environment variables**; the additional `OWNER-LOGIN.txt` contains the generated password for the owner. Copy the complete contents of each of the five environment-value files into **Vercel → Project → Settings → Environment Variables → Production** using its filename without `.txt` as the variable name. Do not create an environment variable from `OWNER-LOGIN.txt`.
4. Redeploy the latest commit. No API rewrite to Render is needed: the repository's root `vercel.json` deploys `api/cloud.ts` alongside Vite. Remove any old dashboard rewrite that forwards `/api/cloud` to a different backend.
5. Keep direct browser access to Realtime Database denied. This repository provides `firebase/database.rules.json` with `.read` and `.write` both false. Deploy those rules to the intended project. Admin SDK access is authorized by its private service account, independently of browser rules.
6. Open `/api/cloud?action=status`. It must return `configured: true`. The response exposes missing variable **names**, never credentials. Then sign in and complete the shop/phone exercise below. A configured flag alone does not verify Firebase permissions.

`CLOUD_TENANT_ID` optionally selects an isolated database namespace; use a stable letters/digits/underscore/hyphen name. Changing it shows a different workspace set. Changing the owner email/password or signing secret invalidates existing owner sessions and device grants; reconnect each authorized device afterward.

## Automatic connection, without a Settings connection form

The Firebase URL and Admin credentials stay configured on the backend. There is no Cloud connection setup form in Settings. When the server is configured, the normal app address opens the cloud owner sign-in and then the shared restaurant workspace automatically. After a successful sign-in, the same saved workspace is remembered for later app launches.

- Every authorized phone, PC and tablet opens the normal app URL and signs in with the cloud owner email/password. A sole ready shared workspace opens automatically. Several business workspaces require an explicit choice; their stock is not merged.
- If there is no cloud business yet, the original device's signed-in local owner is transferred automatically as a consistent baseline followed by pending journal changes, then that source becomes shared. The original local database is retained. An existing cloud business always takes precedence over a different local copy; the app never uploads that copy over shared stock.
- If there is no cloud business and no saved local workspace, the authenticated owner gets one empty shared business with a Main branch and General category. Simultaneous first launches create one cloud workspace. No anonymous write access or default local PIN is created.
- An incomplete original upload is kept for resuming; a second device does not create an empty competing workspace. If local owner authentication has expired during the first transfer, open the original device copy with `/?local=1`, sign in with its private PIN, then return to the normal app address.
- `/?cloud=1` opens the owner's stock, sales, loans, expenses and profit/CSV dashboard. It checks metadata every 10 seconds while visible; the shared POS checks changes every 5 seconds. The network and cloud dots report different states.

`/?local=1` deliberately opens the independent original copy for backup/recovery. It is not a simultaneous second cashier for shared stock. Local-only changes are not automatically merged after cloud authority is established. Background uploads require the app to remain open and online; a suspended PWA cannot promise background work. Local credentials, uploaded photo bytes and device drafts stay in local backups.

## Use the same POS from several online devices

The normal app address opens the ready shared workspace automatically after owner sign-in. The first original-device transfer finishes its upload before becoming shared. Export an external backup of the original local workspace before using the cloud for live work. Legacy monitoring-only sources can also be promoted through **Enable shared POS** in Owner live view.

- Open the resulting `/?shared=SOURCE_ID` URL on **every** device, including the original shop counter. Sign in with the cloud owner email/password. A successfully opened shared workspace is remembered for future PWA launches. Use `/?local=1` only to open the original independent local copy; its later changes do not merge into shared stock. This first implementation authorizes the owner account; local staff PINs/roles are not cloud login accounts.
- Orders, payments, loans, collections, stock, recipes, production, purchases and supported management actions run through the same validated business operations. Firebase compare-and-swap commits the complete transaction. Stock conflicts roll back; repeating an identical command returns its original result.
- Automatic independent uploads for that source are rejected after promotion, so an old local snapshot cannot overwrite shared stock. The original local database and backup remain intact. Continue new work through the shared URL.
- The shared POS requires a cloud connection to confirm transactions. **During an outage new work remains as a draft on that device. Automatic offline financial merging between several writers is not implemented.** A successful payment is recorded before printing; a printer failure does not cancel it.
- Shared owner mode does not migrate staff PIN authentication, hardware discovery, uploaded photos or backup replacement. Use supported photo links; retain the original encrypted local backup. Do not describe this as complete offline multi-device reconciliation.

The owner dashboard is read-only until the separate shared POS is enabled/opened. Source/branch filters do not combine independent workspaces. Source revocation stops upload access and removes it from owner reads without silently erasing local data.

## Recovery after browser clearing or device loss

Cloud recovery covers records that the server actually acknowledged. A cloud connection setting, green network dot or installed PWA alone is not evidence that a particular sale was uploaded.

1. On a replacement device, or after clearing site data, open the normal trusted app address while online. With a configured backend it opens the cloud owner sign-in automatically. `/?cloud=1&restore=1` is also available for explicit recovery.
2. Sign in with the **cloud owner email and password**. Clearing site data also clears sessions and the saved workspace preference, so the app cannot safely restore private shop records into an anonymous browser.
3. If there is exactly one ready shared workspace, recovery opens it automatically after sign-in. Otherwise choose the intended shop/workspace and **Open shared POS**. The app loads its authorized cloud records and remembers that shared workspace again. Use the same shared URL on all authorized devices. A still-valid owner session can reopen the sole ready shared workspace without entering the password again; a fresh anonymous browser must authenticate.
4. Compare the latest sale, stock and customer balance with the expected records before resuming work. If there are several independent sources, select the intended one; they are not interchangeable restore points.

The owner must enable shared POS before using a monitoring-only source as the authoritative workspace. Keep the original local backup: the monitoring projection deliberately excludes local staff credentials, active sessions, uploaded photo bytes, device drafts and the local command/journal store. Reopening a shared workspace does not reconstruct those omitted parts of an independent device database. Use a verified `.hotelbackup` for complete local recovery; that file does not contain shared-cloud changes made after the local export.

An offline sale that never reached the server, an unfinished device draft, or a photo stored only on a lost phone cannot be recovered from Firebase. The cloud is also subject to administrative deletion, account access, quotas and service availability. Do not advertise absolute zero data loss or permanent unlimited retention. The same applies to automatic two-way offline merging: several independent local writers do not reconcile their sales automatically. Shared online devices instead submit transactions to one cloud authority.

## Persistent storage, installation and external backup

The app requests persistent browser storage once after a real workspace opens where the API is supported, including shared workspace caches and drafts. It remembers a denied request and does not repeat it automatically on every launch; **Settings → Device storage & backups** provides a manual retry. The browser decides whether to grant it. Usage/quota and permission state are shown in Settings for both device and shared modes.

Persistence protects granted origins from automatic storage-pressure eviction. It does not prevent deliberate site-data deletion, profile removal, formatting or loss of the device. PWA installation still uses browser-managed site storage; it does not create a second protected database. Clearing ordinary history and clearing website data are different operations. See [Chrome's persistent storage guidance](https://web.dev/articles/persistent-storage).

For an independent device workspace, the Owner can export an AES-256-GCM password-protected `.hotelbackup` with local records, uploaded photos, credential hashes, journal and saved drafts. Keep several dated files outside the operating browser and their passwords separately. Test a restore on a spare empty profile. The shared Settings panel does not present local backup replacement as a cloud restore; retain the original local file and arrange independent backups of the Firebase project according to the agreed recovery plan.

## Connection indicators and acceptance

The two dots mean different things: **Online/Offline** follows this device's network state; **Cloud Synced / pending / unavailable** additionally requires an actual cloud acknowledgement and no pending uploads. A green network dot alone is not evidence of a saved transaction. Owner live view separately shows the shop heartbeat and last upload time.

Before handing over a real business, demonstrate a sale and a partial loan collection on the shop, verify both on a separate phone, disconnect/reconnect the shop and verify pending upload recovery, then test concurrent sale of the final stock unit on two shared devices. Keep separate backups and monitor the actual Firebase/Vercel quotas. No plan has unlimited storage, bandwidth, invocation allowance or uptime.

References: [Vercel Node functions](https://vercel.com/docs/functions/runtimes/node-js), [Firebase Admin setup](https://firebase.google.com/docs/admin/setup), [Admin Realtime Database access](https://firebase.google.com/docs/database/admin/start).
