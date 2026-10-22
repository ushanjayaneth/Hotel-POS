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

## Start with local offline sales and remote viewing

1. On the shop device sign in as its local owner and open **Settings → Cloud connection & owner live view**.
2. Enter the cloud owner email/password and a clear device label, then choose **Connect this shop device**.
3. Keep the app open for the first upload. It reads a consistent local baseline, then uploads later journal transactions in order. Credentials, PINs, sessions, private keys and uploaded photo bytes are excluded. Product photo links remain available; locally uploaded `/api/media` photos stay on the original device.
4. On the owner's phone open the same site's `/?cloud=1`, sign in with the **cloud owner account**, choose the shop and branch, and review stock, sales, loans, expenses and profit/CSV reports.
5. Local changes upload after a short debounce; the viewer checks metadata every 10 seconds while visible and fetches changed records. Use Refresh for an immediate check. This is near-live polling, not a guarantee of instantaneous delivery.

Local sales continue offline. Pending journal records are retained and retried after reconnection while the app is open. A suspended/closed PWA cannot promise background execution. The dashboard shows the last uploaded data and its timestamp when the shop is disconnected. Independent devices are separate sources; their stock is never blindly added or overwritten.

## Use the same POS from several online devices

After the initial upload, the owner can select **Enable shared POS** in Owner live view. Export an external backup first and finish pending uploads. The confirmation explains the change of authority.

- Open the resulting `/?shared=SOURCE_ID` URL on **every** device, including the original shop counter. Sign in with the cloud owner email/password. A successfully opened shared workspace is remembered for future PWA launches. Use `/?local=1` only to open the original independent local copy; its later changes do not merge into shared stock. This first implementation authorizes the owner account; local staff PINs/roles are not cloud login accounts.
- Orders, payments, loans, collections, stock, recipes, production, purchases and supported management actions run through the same validated business operations. Firebase compare-and-swap commits the complete transaction. Stock conflicts roll back; repeating an identical command returns its original result.
- Automatic independent uploads for that source are rejected after promotion, so an old local snapshot cannot overwrite shared stock. The original local database and backup remain intact. Continue new work through the shared URL.
- The shared POS requires a cloud connection to confirm transactions. **During an outage new work remains as a draft on that device. Automatic offline financial merging between several writers is not implemented.** A successful payment is recorded before printing; a printer failure does not cancel it.
- Shared owner mode does not migrate staff PIN authentication, hardware discovery, uploaded photos or backup replacement. Use supported photo links; retain the original encrypted local backup. Do not describe this as complete offline multi-device reconciliation.

The owner dashboard is read-only until the separate shared POS is enabled/opened. Source/branch filters do not combine independent workspaces. Source revocation stops upload access and removes it from owner reads without silently erasing local data.

## Connection indicators and acceptance

The two dots mean different things: **Online/Offline** follows this device's network state; **Cloud Synced / pending / unavailable** additionally requires an actual cloud acknowledgement and no pending uploads. A green network dot alone is not evidence of a saved transaction. Owner live view separately shows the shop heartbeat and last upload time.

Before handing over a real business, demonstrate a sale and a partial loan collection on the shop, verify both on a separate phone, disconnect/reconnect the shop and verify pending upload recovery, then test concurrent sale of the final stock unit on two shared devices. Keep separate backups and monitor the actual Firebase/Vercel quotas. No plan has unlimited storage, bandwidth, invocation allowance or uptime.

References: [Vercel Node functions](https://vercel.com/docs/functions/runtimes/node-js), [Firebase Admin setup](https://firebase.google.com/docs/admin/setup), [Admin Realtime Database access](https://firebase.google.com/docs/database/admin/start).
