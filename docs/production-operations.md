# Production Operations Runbook

Status: **preparation only**. These instructions do not authorize production access, a database write, migration, index operation, or deployment. Use the organization's change approval and operator controls before any production action.

## Production components

The portal is one Next.js application. It serves the web screens and the `/api` endpoints from the same process.

| Component | How it runs |
| --- | --- |
| Application | `npm run build`, then `npm start` on the server, kept alive by a process manager such as PM2 |
| Database | MongoDB Atlas, which provides the replica set that transactions require |
| HTTPS | A reverse proxy on the server, such as Caddy or Nginx, forwarding to port 3000 |
| Virus scanning | ClamAV (`clamd`) on the server or on a separate private host, set through `CLAMAV_HOST` |
| Private uploads | Encrypted files on the server disk in `UPLOAD_DIR`, outside the project folder |

`/api/health` reports that the process is alive. `/api/ready` reports whether the database is reachable.

## First-time server setup

1. Install Node.js 20.9 or newer, and install ClamAV so `clamd` listens on TCP port 3310.
2. Copy the project to the server and create `.env.production` from `.env.production.example`. Keep this file out of source control.
3. Create the upload folder named by `UPLOAD_DIR`, owned by the account that runs the app, with no access for other accounts.
4. Install, check and build:

```bash
npm ci
npm run preflight:production
npm run build
```

5. Start the application under a process manager:

```bash
pm2 start npm --name parenthood-art-bank -- start
```

6. Configure the reverse proxy to terminate HTTPS, forward to `127.0.0.1:3000`, and **replace** the `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` headers with its own values. The app trusts these headers when `TRUST_PROXY=true`, so port 3000 must not be reachable from the internet.
7. Set the proxy's maximum request size to at least 55 MB so that document packages are accepted.
8. Create the first administrator with `NODE_ENV=production npm run seed:superadmin`.

## Configuration preflight

1. Provide production settings through the approved secret-management process. Do not place secrets in a command line, ticket, or terminal transcript.
2. Run `npm run preflight:production`. It checks setting names and formats without printing values. It does not connect to MongoDB.
3. Required settings are `MONGODB_URI`, `JWT_SECRET`, `CLIENT_ORIGIN`, `PORTAL_HOST`, `UPLOAD_ENCRYPTION_KEY`, `CLAMAV_HOST`, `NODE_ENV=production` and `TRUST_PROXY=true`. `PORTAL_HOST` must match the hostname in the HTTPS `CLIENT_ORIGIN`.
4. Production connections disable Mongoose `autoIndex` and `autoCreate`. Before the first release, confirm that every required collection and index exists in the target database.
5. Keep durable custody of `UPLOAD_ENCRYPTION_KEY`. Losing it makes private files and encrypted signature strings unreadable.

## Controlled encryption migration

Normal application startup does not run the legacy encryption migration. If historical at-rest encryption is required, use `scripts/encrypt-legacy-data.js` only as a separately approved operation:

1. Approve a maintenance window and prevent other writes to the same data.
2. Take a consistent database and private-upload backup, and prove it restores in an isolated environment.
3. Validate key custody and test decryption against the restored copy.
4. Review the script against the exact release. It defaults to a read-only dry run, which still connects to the configured database. Execute mode rewrites signature values and private files.

The utility can resume after a failure, but file and database changes are not one atomic transaction.

## Backup and restore

- Back up MongoDB and the `UPLOAD_DIR` folder together. Either one alone can leave records without files, or files without records.
- Use Atlas backups for the database and an encrypted, access-controlled copy of `UPLOAD_DIR` for the files.
- Pause uploads or use a coordinated snapshot so both parts represent the same point in time.
- Store backups and `UPLOAD_ENCRYPTION_KEY` separately.
- Restore first into an isolated environment and validate record counts, attachment downloads, decryption and signature reads before any traffic switch.

## Release sequence

1. Review the release diff and confirm there are no unapproved schema, index, or business-rule changes.
2. Run `npm run preflight:production`.
3. Run `npm test` against a local replica set using only the database name `parenthood_phase1_test`.
4. Complete any required signature-index rollout gates in `docs/signature-index-rollout.md`.
5. Confirm MongoDB transactions, HTTPS, proxy trust, ClamAV health, disk capacity, and a rollback plan.
6. Build, restart the process manager, and confirm `/api/ready` returns HTTP 200.
7. Check login, role and hospital/centre isolation, stock movements, file upload and download, declarations, reports, exports, and audit events.

## Rollback and incident handling

- If a release fails before any data-format or index change, return to the last compatible application release.
- If the encryption migration or a signature-index transition has begun, do not assume rollback is safe. Keep key material and the latest consistent backup, pause affected writes, and follow the reviewed recovery plan.
- Preserve evidence and audit history. Never delete records or files to make a health check pass.

## Open business and infrastructure decisions

| Decision required | Current state | Source |
| --- | --- | --- |
| Hospital/centre master data and chain linkage | Options come from active hospital-user assignments; there is no separate master record. | `src/server/routes/users.js`, `src/server/routes/hospitals.js` |
| Patient record creation and access | The `Patient` model exists and the couple export reads it, but no patient screen or API exists. | `src/server/models/Patient.js`, `src/server/routes/reports.js` |
| Vial return, disposal and expiry rules | Some statuses are declared, but no route moves a vial into them. | `src/server/models/Vial.js`, `src/server/routes/vials.js` |
| Approved declaration wording and signing authority | Correction requests can change only the date and statement. | `src/server/routes/declarationCorrections.js`, `src/server/routes/signatures.js` |
| Versioned signature rollout | Signed corrections stay blocked until the staged rollout is complete. | `docs/signature-index-rollout.md` |

No production command, migration, database operation, or deployment is performed by this runbook.
