# Deployment — audit.audix.co.in

## Environment variables to set in the Emergent deployment UI
`.env` is gitignored (the GitHub repo is public) so the deployed app will NOT get these from git.
After the first deploy, open the deployed app → Environment Variables, paste these, then redeploy.

```
NODE_ENV=production
PORT=8001
DATABASE_URL=<Neon pooled connection string, sslmode=require>
JWT_SECRET=<64-char random; node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))">
JWT_EXPIRES_IN=12h
BCRYPT_ROUNDS=10
STORAGE_DRIVER=s3
UPLOAD_DIR=uploads
PUBLIC_BASE_URL=https://audit.audix.co.in
CLIENT_ORIGIN=https://audit.audix.co.in
S3_ENDPOINT=https://f161c8ad4feaed0e7137324f676e0e8e.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=audix-photos
S3_ACCESS_KEY=<R2 access key id>
S3_SECRET_KEY=<R2 secret access key>
S3_PUBLIC_URL=https://pub-3547de2743ef47b39495bfe214816240.r2.dev
S3_FORCE_PATH_STYLE=true
```

With `NODE_ENV=production` the server refuses to start if JWT_SECRET / DATABASE_URL / CLIENT_ORIGIN
are dev defaults (`server/src/config.js` → `assertProductionConfig`). All three values above pass.

## Build & start
- Build: `npm run build` (root) → runs `vite build`, output `client/dist`
- Start: `npm start` (root) → `node server/src/index.js` on port 8001
- Express serves `client/dist` when it exists (single origin). If it does not exist the API runs
  standalone and the client can be hosted separately — CORS config is retained for that case.
  Override the location with `CLIENT_DIST` if the build lands elsewhere.

## Custom domain
Subdomain only: `audit.audix.co.in`. Emergent → deployed app → Link domain → Entri gives a CNAME.
Add that CNAME at the registrar. The root `audix.co.in` records are untouched, so the existing
website on the root domain is unaffected.

## Post-deploy checklist
1. Login as `arvind`, open Admin → System Readiness — everything green except item master.
2. Item Master → CSV import → `Item_Master_Import_Ready.csv`.
3. Stores & Users → create the store(s) and the auditor accounts.
4. Upload one photo from a phone and confirm it loads back (proves R2 wiring in production).
5. Reports → export one XLSX and one PDF.
