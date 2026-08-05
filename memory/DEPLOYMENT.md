# Deployment — audit.audix.co.in (Railway)

Emergent deployment was abandoned: its pipeline hardcodes `backend/.env` + `frontend/.env`, and this
repo uses `server/` + `client/`. Renaming would break the user's own GitHub workflow, so the app is
deployed on Railway instead, with no repo restructuring.

## Verified locally from a clean `git clone` (production mode)
```
npm install          # root
npm run build        # installs server deps (--omit=dev), client deps (--include=dev), vite build
npm start            # node server/src/index.js on $PORT
```
Result: `Environment: production`, `Storage driver: s3`, `Serving built client from client/dist`,
`/api/health` 200 JSON, `/` 200 html, `/admin/reports` 200 html, login returns a JWT.

`--include=dev` on the client install matters: Railway sets `NODE_ENV=production`, which otherwise
makes npm skip devDependencies and `vite` would not be installed.

## Railway setup
1. railway.app → sign in with GitHub → **New Project** → **Deploy from GitHub repo** →
   `arvindprowess-sketch/The-Daryaganj-Gold`, branch `main`.
2. Railway auto-detects Node, runs `npm run build`, starts with `npm start`. No Dockerfile needed.
3. Service → **Variables** → paste the block below (Railway supplies `PORT` itself — do not set it).
4. Service → **Settings** → **Networking** → **Custom Domain** → `audit.audix.co.in` → add the CNAME
   it gives you at the registrar. Root `audix.co.in` records stay untouched.
5. Health check path: `/api/health`.

## Environment variables (Railway → Variables)
```
NODE_ENV=production
DATABASE_URL=postgresql://neondb_owner:npg_rKbHxT81cDCO@ep-fragrant-rain-axpdjywl.c-4.us-east-2.aws.neon.tech/neondb?sslmode=require
JWT_SECRET=oKFPevzEOJpqr8yMlmXtirARUwJC1JVoq8-H2h4wgZloHVuvhSqfnQ_82Muimb5C
JWT_EXPIRES_IN=12h
BCRYPT_ROUNDS=10
STORAGE_DRIVER=s3
UPLOAD_DIR=uploads
PUBLIC_BASE_URL=https://audit.audix.co.in
CLIENT_ORIGIN=https://audit.audix.co.in
S3_ENDPOINT=https://f161c8ad4feaed0e7137324f676e0e8e.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=audix-photos
S3_ACCESS_KEY=9abee585e78eff51e39cde5e0a7d5061
S3_SECRET_KEY=c74536c192df0da5d46980d7c21ca23ebb306f9575d66489f750b4a925369da4
S3_PUBLIC_URL=https://pub-3547de2743ef47b39495bfe214816240.r2.dev
S3_FORCE_PATH_STYLE=true
```
`.env` stays gitignored — the GitHub repo is PUBLIC and must never carry these values.
With `NODE_ENV=production`, `assertProductionConfig()` exits the process if any of JWT_SECRET /
DATABASE_URL / CLIENT_ORIGIN look like a dev default; the values above pass.

## Post-deploy checklist
1. Log in as `arvind` → Admin → System Readiness (everything green except item master).
2. Item Master → CSV import → `Item_Master_Import_Ready.csv`.
3. Stores & Users → create the store(s) and auditor accounts.
4. Upload one photo from a phone and confirm it loads back (proves R2 in production).
5. Reports → export one XLSX and one PDF.

## Known cosmetic item (repo code, not changed)
The login page footer still shows `Auditor demo: rakesh / rakesh123 · Admin: admin / admin123`.
Those accounts do not exist in the Neon database. Worth removing from `client/src/pages/Login.jsx`
before go-live.
