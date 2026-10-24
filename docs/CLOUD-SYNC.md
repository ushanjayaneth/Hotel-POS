# Firebase connection and shared POS

The normal app address uses one backend-configured Firebase Realtime Database for the shop. Open that address on each authorized phone, tablet or computer and enter the ordinary **POS PIN** when requested. The app opens the shop automatically. There is no separate cloud admin login, workspace picker, or Cloud connection form in Settings.

The Firebase URL and Admin credentials stay on the server. A signed, HttpOnly session authorizes each device after PIN verification. Direct anonymous database reads and writes remain denied. An internet connection or a configured flag alone does not prove a successful database write.

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

**Shared confirmations require internet.** During an outage, a device can retain its cached view and new draft; it cannot confirm a shared sale, payment or stock change until the server accepts it. Separate offline financial writers are not automatically reconciled. A payment is saved before printing, so a printer failure does not cancel it.

The shared POS checks for server changes while visible. The network and cloud dots report different states: **Online/Offline** describes this device's network; the cloud indicator reports actual recent server contact and whether uploads or connection failures remain. A green network dot alone is not proof that a sale reached Firebase.

## Recovery after browser clearing or device loss

1. Open the normal trusted app address while online on the replacement device or cleared browser.
2. Enter the same private POS PIN when requested. Clearing site data clears its session too; private shop records are not returned to an anonymous browser.
3. The app opens the shop automatically and loads its authorized cloud stock, sales, loans and reports. No separate admin account or workspace selection is required.
4. Compare the latest sale, stock and customer balance with the expected records before resuming work.

Cloud recovery covers records the server actually acknowledged. A sale that never reached the server, an unfinished draft, or a photo saved only on a lost phone cannot be recovered from Firebase. The cloud projection also excludes local staff credentials, active sessions, uploaded photo bytes and the original command/journal store. Reopening shared POS does not reconstruct those parts of an independent device database.

Keep verified `.hotelbackup` files for complete local recovery. A local backup captures its original workspace at export time; it does not include later changes made only in the shared cloud business. Firebase remains subject to administrative deletion, account access, quotas and service availability. Do not promise absolute zero data loss or unlimited retention.

## Browser storage and external backups

The app requests persistent storage once after a real workspace opens where supported. It remembers a refused request; **Settings → Device storage & backups** provides a manual retry, usage/quota and permission state. The browser decides whether to grant persistence.

Granted persistence protects against automatic storage-pressure eviction. It does not prevent deliberate site-data deletion, profile removal, formatting or device loss. An installed PWA still uses browser-managed site storage rather than a second protected database. Clearing ordinary browsing history and clearing site data are different operations. See [Chrome's persistent storage guidance](https://web.dev/articles/persistent-storage).

For an independent local workspace, the Owner can export an AES-256-GCM password-protected `.hotelbackup` containing records, uploaded photos, credential hashes, journal and drafts. Keep dated copies outside the operating browser, keep passwords separately, and test restoration on an empty spare profile. Shared Settings does not present local backup replacement as a cloud restore. Arrange independent Firebase backups according to the agreed recovery plan.

## Acceptance before handover

Demonstrate a sale and partial loan collection on the shop device, then verify the updated stock, loan balance and report on a second phone using the same POS PIN. Test an interrupted initial upload and recovery after clearing a spare browser. On two shared devices, attempt to sell the final stock unit simultaneously and confirm that it cannot be oversold. During a network outage, confirm that shared work remains a draft and is accepted once after reconnecting.

Keep separate backups and monitor the actual Firebase/Vercel quotas. No plan provides unlimited storage, bandwidth, function invocations or uptime.

References: [Vercel Node functions](https://vercel.com/docs/functions/runtimes/node-js), [Firebase Admin setup](https://firebase.google.com/docs/admin/setup), [Admin Realtime Database access](https://firebase.google.com/docs/database/admin/start).
