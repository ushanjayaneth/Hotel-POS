# Host the frontend on Vercel and the backend on Render

This guide connects the existing Vercel frontend to the Node backend and a persistent SQLite database. You complete the deployment in your own hosting accounts. The files in [deployment](../deployment/) are examples; they do not change the live site until you apply them.

Use a **paid Render Node web service with a persistent disk** for this version. Render's free web services cannot attach persistent disks and lose local SQLite files when they restart, redeploy, or spin down. See [Render free service limits](https://render.com/docs/free) and [persistent disks](https://render.com/docs/disks).

The deployment has this request path:

```text
Browser -> hotel-pos-kappa.vercel.app/api/... -> Render Node service -> SQLite on /var/data
```

The browser continues using the Vercel address, including for sign-in and API requests. Vercel supports this through an [external rewrite](https://vercel.com/docs/routing/rewrites).

## 1. Create the backend service

1. Sign in to Render and select **New > Web Service**.
2. Connect your GitHub account and choose `ushanjayaneth/Hotel-POS`.
3. Choose branch `main` and the repository root directory. Do not select Static Site.
4. Set the service values below. Review the displayed hosting and disk charges before creating it.

| Setting             | Value                                             |
| ------------------- | ------------------------------------------------- |
| Name                | `hotel-pos-backend`, or another available name    |
| Runtime             | Node                                              |
| Build command       | `npm ci --include=dev && npm run build`           |
| Start command       | `npm start`                                       |
| Instance            | A paid instance compatible with a persistent disk |
| Health check path   | `/api/health`                                     |
| Number of instances | `1`                                               |

Keep development dependencies installed: this repository uses TypeScript and `tsx` during the build and server startup. Render supplies `PORT` automatically; leave it unset in your environment settings. The server reads it and listens on `0.0.0.0`.

Under the service's disk settings, create a disk with:

| Disk setting | Value            |
| ------------ | ---------------- |
| Mount path   | `/var/data`      |
| Size         | `1 GB` initially |

Only files under the disk mount persist. The database path in the next step places both SQLite and the application's adjacent backup directory there. Keep this SQLite service on one instance; a persistent disk cannot be shared across multiple running instances. [Render disk behavior](https://render.com/docs/disks).

## 2. Add backend environment variables

Add these values in **Render > Service > Environment** before the first successful start:

| Key                 | Value                                      |
| ------------------- | ------------------------------------------ |
| `NODE_VERSION`      | `24.21.0`                                  |
| `NODE_ENV`          | `production`                               |
| `POS_DEMO_MODE`     | `false`                                    |
| `COOKIE_SECURE`     | `true`                                     |
| `DATABASE_PATH`     | `/var/data/hotel-pos.sqlite`               |
| `ALLOWED_ORIGINS`   | `https://hotel-pos-kappa.vercel.app`       |
| `INITIAL_ADMIN_PIN` | Your own unique PIN containing 6–12 digits |

Enter the PIN privately in Render. Do not put it in source code, `vercel.json`, a GitHub commit, or a `VITE_*` variable. Preserve leading zeroes if your PIN contains them.

`INITIAL_ADMIN_PIN` creates the first Owner account only when the selected database has never been initialized. Changing this environment variable later does not change an existing account's PIN. A new live database does not contain the demo staff PIN accounts. Production mode also disables demo account seeding.

Render supports an explicit `NODE_VERSION` environment variable, which takes precedence over its default. [Render Node version configuration](https://render.com/docs/node-version).

If you later use a custom frontend domain, replace `ALLOWED_ORIGINS` with that exact HTTPS origin. Multiple trusted origins can be comma separated with no spaces. Do not use `*` or include a trailing `/`.

Use the Vercel address for the sign-in steps below. If you also want to use the frontend served directly by Render, add that exact HTTPS origin to `ALLOWED_ORIGINS` as another trusted origin.

## 3. Deploy and check the backend

Create or deploy the web service, then wait until Render reports it live. Copy its public HTTPS address, for example:

```text
https://YOUR-BACKEND.onrender.com
```

Open this address with `/api/health` appended. A working service returns JSON resembling:

```json
{
  "ok": true,
  "service": "demo-hotel-branch-hub",
  "database": "sqlite",
  "time": "..."
}
```

Do not continue until this works. If startup fails, read the Render logs. An invalid or missing initial PIN prevents a fresh production database from starting. A disk mounted at a different path does not protect the database configured above.

For optional Blueprint deployment, review [render.example.yaml](../deployment/render.example.yaml), then copy it to the repository root as `render.yaml` and create a Render Blueprint from that file. The example declares a paid instance and a 1 GB disk. Its secret PIN uses `sync: false`, so you supply the value privately during initial Blueprint setup. Check the current service plan options in [Render's Blueprint reference](https://render.com/docs/blueprint-spec) before applying it.

## 4. Connect the Vercel frontend

Copy [vercel.example.json](../deployment/vercel.example.json) to the repository root as `vercel.json`. Replace `YOUR-BACKEND` in its destination with the actual Render service hostname. Keep `/api/:path*` at the end:

```json
{
  "source": "/api/:path*",
  "destination": "https://YOUR-BACKEND.onrender.com/api/:path*"
}
```

Retain the example's API response headers. They disable caching for authenticated API traffic. Use a rewrite so requests and the session cookie stay under the frontend origin. [Vercel external rewrites and caching](https://vercel.com/docs/routing/rewrites).

Commit the completed `vercel.json` and push it to GitHub. In your Vercel project, use:

| Setting          | Value                  |
| ---------------- | ---------------------- |
| Framework preset | Vite                   |
| Root directory   | Repository root        |
| Install command  | `npm ci --include=dev` |
| Build command    | `npm run build`        |
| Output directory | `dist`                 |
| Node.js version  | `24.x`                 |

Redeploy the frontend. This Vercel build produces the browser app; `npm start` runs on Render.

Open `https://hotel-pos-kappa.vercel.app/api/health`. It should return the backend health JSON. Then open `/api/session` on the same Vercel domain. Before login, a fresh live database should return:

```json
{ "user": null, "demo": false }
```

These checks confirm that Vercel is forwarding API requests to the backend. If a previously installed app still uses old files, reload it after the deployment and allow the app update to finish.

## 5. Sign in as the administrator

Open the Vercel app, enter your chosen `INITIAL_ADMIN_PIN` in **Staff PIN**, and select **Open workspace**. The first account is named **Administrator** and has the **Owner** role. There is no separate `/admin` login page.

The Owner can access Settings, Products, Team, Reports, and the other management pages from the workspace. Create individual staff accounts in Team. Check the business name, prices, stock, tax, service charge, receipt alignment, and cash shift setup before recording real transactions. Demo PIN buttons do not create accounts on a live database.

Create an application backup from Settings and keep a downloaded copy outside the hosting account. Follow the [backup instructions](OPERATIONS.md#backups) and [restore procedure](OPERATIONS.md#restore-procedure) when validating recovery. A persistent disk protects data across service restarts; retain separate recoverable backups as well.

## Internet access, printers, and Firebase

With this cloud backend, confirming orders, taking payments, and sharing branch data require an internet connection to Render. A cached browser app and saved local drafts remain useful during an outage, but they cannot confirm transactions while the backend is unreachable. For the original requirement to keep a whole branch operating without internet, run the Node hub on a branch computer or server reachable over the local network, with its database stored there. Hosting on Render does not replace that branch hub design.

Printer discovery and network printer checks run on the backend host. On Render they cannot see printers connected to your shop PC or private shop network. Browser printing can still use printers installed on the device. A local branch hub is needed for backend printer discovery in the shop. Barcode scanners operating as keyboards enter codes on the device running the browser.

Firebase synchronization is a separate setup. A Realtime Database URL alone does not enable it. The included receiver requires server-side Firebase credentials, while each hub needs the receiver's `SYNC_ENDPOINT`, a matching `SYNC_TOKEN`, and a unique `HUB_ID`. Keep those credentials in private service environments and follow the [Firebase sync integration contract](OPERATIONS.md#firebase-sync-integration). Do not place Firebase Admin credentials or private keys in Vercel's browser configuration.

## Troubleshooting

| Symptom                                 | What to check                                                                                                                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel `/api/health` returns `404`      | Confirm root `vercel.json` exists, its destination includes `/api/:path*`, and the latest frontend deployment contains it.                                                                                              |
| Vercel returns `502` or a gateway error | Test Render `/api/health` directly and inspect Render startup logs.                                                                                                                                                     |
| Sign-in returns `ORIGIN_FORBIDDEN`      | Match `ALLOWED_ORIGINS` to the exact frontend origin you are using. A Vercel preview address is a different origin.                                                                                                     |
| Sign-in says PIN incorrect              | Use the PIN supplied for the first initialization of this database. Demo PIN `1234` does not belong to a new live database.                                                                                             |
| Login succeeds but the session is lost  | Use HTTPS and inspect `/api/login` plus `/api/session` through the Vercel address; the `demo_hotel_session` cookie must be accepted there.                                                                              |
| Sign-in returns `429`                   | Wait 15 minutes after repeated failed attempts. With the current proxy configuration, clients can share a backend IP and therefore a login failure limit; trusted proxy handling requires a separate deployment review. |
| Data disappears after redeploy          | Verify an attached persistent disk and `DATABASE_PATH=/var/data/hotel-pos.sqlite`. Keep the database path unchanged between deploys.                                                                                    |
| Printer list is empty on Render         | Discovery checks the cloud host. Use browser printing or a local branch hub for shop printers.                                                                                                                          |
