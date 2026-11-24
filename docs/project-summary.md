# Parenthood ART Bank – Project Summary

Last updated: 24 November 2026. Latest commit on GitHub `main`: `ab13ebf`.

## What the project is

One Next.js 16 app (React pages and the backend API together, no Docker) for the Parenthood ART Bank:
donor registry, collection batches, vials, hospital dispatch, couple cases, statutory declarations,
documents, reports, audit trail, users and signatures.

- Code: https://github.com/abhimahant4-star/Parenthood-ART-BANK
- Live site: https://parenthood-art-bank.vercel.app
- Database: MongoDB Atlas, database `parenthood_art_bank` (connection string in `.env.local`, never committed)

## Run it on this computer

```bash
npm install
npm run dev
```

Open http://127.0.0.1:3000. Sign in as `superadmin` with the password set in `SEED_SUPERADMIN_PASSWORD` in `.env.local`
(change it before real use). Restart `npm run dev` after pulling new code.

Other commands:

| Command | Purpose |
| --- | --- |
| `npm run build` | Production build |
| `npm run seed:superadmin` | Create the first Super Admin in an empty database |
| `npm run db:local` | Start a private local MongoDB (port 27018) instead of Atlas |
| `npm test` | Automated tests (needs `MONGODB_URI` pointing at a local `parenthood_phase1_test` database) |
| `node scripts/setup-vercel.js` | Push production settings to Vercel and redeploy |

## Deployment (Vercel)

- Settings on Vercel: `MONGODB_URI`, `JWT_SECRET`, `UPLOAD_ENCRYPTION_KEY`, `CLIENT_ORIGIN`, `TRUST_PROXY=true`, `CLAMAV_HOST`.
- Atlas Network Access allows `0.0.0.0/0` so Vercel can connect; the database password is the main protection.
- File uploads do not work properly on Vercel (no permanent disk, no virus scanner). Use a VPS for real document uploads.

## Features added in this work

- **Netlify-style design on every page**: navy header, pink active tab, heading cards with counts, ID chips, blood group and stock pills.
- **Donors**: screening results (HIV, HBsAg, HCV, VDRL, thalassemia, karyotype), Retired status, filters, CSV export, quick UHID search.
- **Short IDs by blood group**: new batches `O+101`, `B-101`, `AB+101`; vials `O+101-1` to `-5`. Older `BAT-` and `ARTB-` IDs stay.
- **Flexible search**: IDs match with or without letters, `+`, `-` or `/` (e.g. `4545` finds `O/4545`).
- **Reports**: donor registry, 6-month quarantine ledger, utilization and mapping (CSV, blood group filter).
- **Audit trail**: action/entity filters, CSV export, Inspect details.
- **Dispatch**: released-stock summary by blood group (karyotype-tested vs normal).
- **Super Admin only**: edit and delete donors, batches and vials (type-to-confirm, safety rules, audited);
  vial History; Unlock locked accounts; link hospitals to a CEO from **Users → Edit scope / CEO**.
- **Login lockout**: 3 wrong passwords lock any account for 15 minutes.
- **Couple cases**: at least one partner must give an ID type and number (any approved ID).
- **Map vial**: hospital types the vial ID instead of picking from a list.
- **Create declaration**: search donor ID first, then only that donor's linked cases appear.
  Patient age, sex, referral, sample ID, donor documents and statement were removed.
- **Dashboard**: balanced columns, inventory overview as a full-width row.

## Still to do

1. Change the `superadmin` password (it is weak).
2. Link the FORTIS hospital to CEO "Gaurav (Shivay)": Users → FORTIS → Edit scope / CEO → choose the CEO → Save.
3. Confirm Vercel redeployed commit `ab13ebf` (Vercel → Deployments, or click Redeploy).
4. For real document uploads, move hosting to a VPS with ClamAV (see `docs/production-operations.md`).
