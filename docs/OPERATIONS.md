# Branch operations runbook

This runbook describes the current DEMO HOTEL implementation. It is a deployment guide for a controlled pilot; it does not certify a production installation or complete the wider POS master plan.

## Branch topology

Run one authoritative hub for each operating branch. Cashiers, waiters, kitchen devices, and managers use that hub's web address. Give the hub a stable LAN address or DNS name. Keep the hub, router, and critical printers on protected power. Maintain router/Wi-Fi access when internet service fails.

The hub stores confirmed transactions in a local SQLite database with WAL journaling, full synchronous writes, foreign keys, and transactions. Each accepted mutation also writes an outgoing sync event in the same transaction. Browser IndexedDB stores drafts and cached snapshots; it is useful during a device disconnect and is not the system of record.

The demonstration branch selector shows separate branch records in a single database. Deploying independent hubs requires configured branch provisioning, distinct hub identities, a central receiver, and validated reporting/restore rules. Do not run multiple independent writable copies of a branch database or place SQLite files on a shared network drive.

## First deployment

1. Install Node.js 24.14 or later, install dependencies with `npm ci`, and run `npm run build`.
2. Create a dedicated operating-system service account and an access-controlled local data directory. Exclude it from public web directories and cloud folder synchronization.
3. Start with a new `DATABASE_PATH`, `POS_DEMO_MODE=false`, and a unique 6–12 digit `INITIAL_ADMIN_PIN`. Keep the initial PIN in a secret store or protected service environment.
4. Configure the hub service with `NODE_ENV=production`, `HOST=127.0.0.1`, and a selected `PORT` behind the local reverse proxy. Start with `npm start`.
5. Serve the app through a trusted HTTPS hostname. Set `COOKIE_SECURE=true` for that origin. Preserve the request host through the proxy; allow only the exact trusted origin if `ALLOWED_ORIGINS` is needed. Test authentication and mutation requests through the real origin.
6. Configure real staff accounts, branch details, menu prices, recipes, supplier data, stock, opening balances, receipt text, tax, and service charge before trading. A fresh non-demo database has no demo sales but still contains starter catalog/branch templates requiring review.
7. Validate receipts, tax calculations, rounding, refund permissions, stock movements, kitchen transitions, shift reconciliation, and backup recovery with the business owner and accountant.

`npm start`, `npm run dev`, and `npm run start:cloud` load an optional local `.env` file. Configure the service environment for hosted deployments, or use `node --env-file=.env --import tsx server/index.ts` manually. Protect `.env` with OS access controls and keep it out of source control. Once a database has been initialized, changing `POS_DEMO_MODE` does not reset it or rotate existing credentials.

For a Vercel frontend and persistent hosted API, follow the [Render connection guide](HOSTING-VERCEL-RENDER.md). Cloud-hosted transactions require internet. Keep the branch LAN topology above when trading must continue through internet outages.

Do not expose the hub directly to the public internet. Restrict network access to trusted branch devices or a managed VPN. Automatic service startup and restart, disk-space monitoring, TLS renewal, OS updates, firewall rules, time synchronization, and recovery access need setup at the deployment site.

## Staff access and sessions

Use separate named accounts and the minimum required role. PINs are salted and hashed with scrypt; sessions use random tokens, an HttpOnly SameSite cookie, and a 12-hour expiry. The server validates role and branch permissions on requests. Shared demo PINs are publicly documented and must remain confined to the demo database.

The current initial-admin PIN is used only when a new database is created. Credential rotation and account recovery must be handled through an approved administrative process; do not treat an environment-variable change as a password reset. Review inactive staff and sign out on shared devices. Cached data/drafts can remain in browser storage after use, so protect the device account and clear it before reassignment. Browser caches are not encrypted by this app.

Before production, review authorization coverage, origin checks, proxy configuration, login throttling, sensitive data exposure, session invalidation, retention, and tenant isolation with an independent security review. Use OS disk encryption for the hub and managed mobile devices, and encrypt backup copies.

## Starting and ending service

At opening, confirm the hub connection, correct branch, current menu availability, prepared stock, and an open cash shift. Verify the printer and a test receipt. Card/QR confirmation must follow an approved transaction on the actual terminal or bank system; the app records the result.

Send orders to the kitchen once. A retry with the original command ID is deduplicated by the hub. If another device changed an order, refresh before repeating the action. Never re-create a bill solely because a response was delayed; check Orders first. Mark preparation states on the kitchen display and close dine-in tables after settlement and service completion.

Payment and food preparation are separate: a paid takeaway/delivery ticket stays in the kitchen until it is marked served. It completes after payment and guest handoff are both recorded. Paying early must not hide an unprepared meal.

At closing, settle open bills, review refunds and adjustments, count cash, reconcile the shift, review stock exceptions, and create/download a verified backup. Investigate queued or failed cloud events; a green local hub connection does not prove cloud replication. Record who checked the closing balances and backups.

## Internet and hub outages

| Condition | Expected behavior |
| --- | --- |
| Internet unavailable; branch hub and LAN work | Local order, kitchen, payment, and stock workflows continue. Outgoing cloud events remain queued. |
| One device loses the hub | Saved snapshots are viewable; new local drafts remain on that device. Confirming orders and payments require reconnection. |
| Hub is stopped or loses power | Shared transactions stop. Restore power/connectivity or use the business's documented manual fallback. |
| Browser storage is cleared | Device drafts and cached snapshots can disappear. Confirmed hub records remain in SQLite. |

Do not clear browser storage while unsent drafts exist. Keep the same device and browser profile, reconnect to the hub, review the draft and prices, and submit it once. Device-local drafts do not synchronize between devices. After a hub interruption, confirm the API health, signed-in account, order totals, kitchen state, and open cash shift before normal service resumes.

## HTTPS and PWA setup

Use HTTPS with a certificate trusted by every phone/tablet and a consistent hostname. A private LAN HTTP URL can open the browser app but normally cannot install/use its service worker. Localhost is a development secure-context exception. [Browser secure-context requirements](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts). Do not disable certificate validation as a deployment workaround.

Install the PWA only after checking login, online operation, and a controlled outage on each supported browser/device. WebKit, Chromium, and Firefox may manage storage and PWA installation differently. An installable app does not make device-local drafts durable against device loss. Save active work before applying the app's update prompt. Test upgrades with an existing database and cached older frontend before rollout.

## Backups

An owner can create a backup through Settings. The hub uses SQLite's backup API, checks the resulting database with `PRAGMA integrity_check`, and writes a SHA-256 sidecar file. The current local destination is a `backups` directory next to `DATABASE_PATH`. The UI download exports the database; the checksum is returned by the backup API and the sidecar remains on the hub.

1. Create a backup after a closed shift and before upgrades or maintenance.
2. Copy the `.sqlite` file **and its `.sqlite.sha256` sidecar** to an encrypted off-device location. A backup on the same disk does not protect against disk loss.
3. Verify its SHA-256 against the sidecar and record date, branch/hub identity, application version, size, and responsible operator.
4. Apply an approved retention policy with multiple restore points. Alert on missed backups or storage failures. Automatic off-device scheduling/retention is an operator responsibility in this version.
5. Run periodic restore drills on a separate machine or temporary database. Verify totals, open orders, staff access, stock balances, and queued sync events.

Do not copy only a running SQLite main file as a backup: uncheckpointed WAL data may be missing. Use the application's backup API or stop the hub and follow a validated database backup procedure. Backups contain business data and credentials; limit access accordingly. Cloud replication is not a substitute for independently retained backups.

## Restore procedure

1. Stop **all** hub processes and prevent device writes. Keep the original database, WAL/SHM files, recent logs, and incident details for recovery review.
2. Copy a known-good `.sqlite` backup and matching `.sqlite.sha256` sidecar into a protected local folder. Verify that they belong to the intended branch/hub.
3. Run the included restore tool, replacing the example paths with the verified source and intended target:

```powershell
node --import tsx server/restore.ts --source "E:\POS recovery\verified-backup.sqlite" --target "E:\POS data\branch.sqlite"
```

The tool validates the checksum when a sidecar is present, checks SQLite integrity and required tables, preserves an existing target as a `.before-restore-...` copy, and replaces the stopped target. The script cannot prove that all hub readers have stopped; the operator must stop the service first. Use a trusted backup with its checksum; a missing sidecar skips the checksum comparison.

4. Start the hub with `DATABASE_PATH` pointing to the restored target. Sign out/in on devices, refresh, and reconcile records against receipts and manual activity since the restore point. Saved old sessions may be present in a restored database; review access before reopening service.
5. Review cloud acknowledgements and pending events before enabling replication. Old events may be replayed from a backup. The receiver must deduplicate them by immutable event ID. Cloud-to-local reconstruction and conflict reconciliation are not implemented.

## Firebase sync integration

The included `server/cloud.ts` runs as a separate trusted service between branch hubs and Firebase Realtime Database. It uses the Firebase Admin SDK with Application Default Credentials. No actual Firebase project or credentials are configured in this workspace. Keep all service credentials on the receiver; browsers and branch client bundles must never receive them. [Firebase Admin setup](https://firebase.google.com/docs/database/admin/start).

Configure these values in the receiver's protected service environment, then start it with `npm run start:cloud`:

| Receiver variable | Purpose |
| --- | --- |
| `FIREBASE_DATABASE_URL` | The actual Realtime Database instance URL. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Absolute path to a protected service-account JSON file, or use the hosting platform's managed Application Default Credentials. |
| `CLOUD_TENANT_ID` | Tenant namespace; defaults to `demo-hotel`. Use a separate value for each business. |
| `CLOUD_HUB_CREDENTIALS` | JSON mapping each hub ID to its authorized `branchId` and secret `token`. Tokens require at least 32 characters. Exactly one active hub credential is allowed per branch. |
| `CLOUD_HOST`, `CLOUD_PORT` | Bind host and port; defaults to `0.0.0.0:3002`. Restrict the port behind the HTTPS proxy/firewall. |

Credential JSON shape, with a placeholder that must be replaced by a long randomly generated token:

```json
{"colombo-hub":{"branchId":"b1","token":"replace-with-a-long-random-secret"}}
```

If using an environment file, explicitly load it:

```powershell
node --env-file=.env.cloud --import tsx server/cloud.ts
```

Deploy the receiver behind HTTPS, restrict its public surface, monitor it, and apply restrictive Firebase client rules. The Admin SDK can access privileged database data, so rules alone do not protect a leaked service credential. Use the least permitted service identity and protect/rotate both Firebase credentials and hub tokens. A health response confirms that the process is running; it does not prove a successful database write.

On each branch hub, set `HUB_ID` to its credential key, `HUB_BRANCH_ID` to its authorized branch (defaults to `b1`), `SYNC_ENDPOINT` to the receiver's HTTPS `/api/ingest` URL, and `SYNC_TOKEN` to that hub's matching token. The Firebase origin is receiver-only server configuration. The branch API never returns it, and setting it alone does not activate sync. The hub sends up to 50 events per request, periodically retries failures with backoff, and marks only acknowledged IDs as synchronized.

When configured, the hub queues an initial branch baseline plus later command changes. The baseline includes public catalog/branch/staff records, settings, stock, history, and operational records. It excludes credential hashes/salts, sessions, and local command bookkeeping. The cloud projection therefore cannot replace a full SQLite backup for complete recovery.

```json
{
  "hubId": "colombo-hub",
  "events": [
    {
      "id": "event-unique-id",
      "commandId": "command-unique-id",
      "branchId": "b1",
      "sequence": 1,
      "action": "order.create",
      "actor": "staff-id",
      "createdAt": "2026-10-17T12:00:00.000Z",
      "changes": []
    }
  ]
}
```

The receiver returns `{"acceptedIds":["event-unique-id"]}` **only after durable persistence**. It validates hub/branch authorization and event structure, deduplicates immutable event IDs, claims per-hub sequence numbers, and writes a projection under `tenants/{tenant}/branches/{branch}/projection`. The original events remain under the same branch's `events` path. Newer per-record sequence numbers prevent delayed retries from overwriting more recent state; the branch projection has one authority hub.

An old local restore that generates a new event at an already-used sequence is rejected and requires operator reconciliation. A replacement hub also needs an explicit authorized transfer. Do not disable those checks or overwrite the cloud ledger to make an error disappear. Independent local full-database backups remain necessary; cloud-to-local reconstruction and automated reconciliation are not implemented.

Test the real Firebase deployment with duplicate requests, interrupted projection writes, partial acknowledgements, timeouts, long offline intervals, token rotation, disk full, reordered events, and replay after restore. The local automated receiver tests use injected persistence and do not certify a live Firebase installation.

A Firebase rules review, cloud authentication, monitoring, off-device backup retention, central reporting, branch provisioning, and a recovery drill are deployment prerequisites. The current UI's branch switching is not proof of a complete cross-branch cloud deployment. This receiver provides one-way change replication; it does not route remote orders back to branch hubs or implement bidirectional merges.

## Payments, printing, and compliance

Cash/card/QR records are operational records. This app does not move money, integrate a payment gateway, confirm bank transactions, or store card data. Verify payment approvals independently. Test payment retries and the manager refund process with the actual business policy.

Receipts use browser printing. Validate 58/80 mm paper settings, margins, fonts, printer drivers, repeated prints, power loss, and kitchen routing on actual equipment. Direct thermal/USB/network printers, cash drawers, and automatic printer discovery are not integrated.

Tax, service-charge, invoice/receipt numbering, discounts, rounding, accounting exports, payroll, privacy, record retention, and statutory reporting require review against the business's current Sri Lankan obligations. The app is not certified for those requirements. Obtain accountant and owner sign-off on a controlled pilot before live trading.

## Firebase access rules

The branch web app does not access Realtime Database directly. Keep the database origin and Admin credentials in the receiver environment, outside Git and outside any VITE_* variable. The branch bootstrap response contains sync status only, never the database URL.

The repository includes default-deny rules at `firebase/database.rules.json` and a Firebase CLI configuration in `firebase.json`. These files do not change the live project until an authorized administrator deploys them. With Firebase CLI authentication for your project, run:

```powershell
firebase deploy --only database --project YOUR_PROJECT_ID
```

The Admin SDK receiver uses its server identity and does not require public database rules. Verify direct unauthenticated reads are denied after deployment. A hidden URL does not provide database authorization.
