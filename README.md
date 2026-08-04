# Audix — Stock Audit App

A mobile-first stock audit web application for **Audix Solutions & Co.**
Auditors visit client outlets, log in on a phone, and count stock item by item
with photographs to help identify items. Admins manage master data, run audit
sessions, enter system stock, and generate reports.

- **Frontend:** React + Vite + Tailwind (`/client`)
- **Backend:** Node + Express (`/server`)
- **Database:** PostgreSQL
- **Auth:** JWT + bcrypt
- **File storage:** local `/uploads` in dev, S3-compatible interface (R2/S3) in prod

---

> **Item names are the identifier.** The client's inventory does not use item
> codes, so there is no `code` column. Names are unique case-insensitively, and
> every comparison (CSV import, photo matching, system stock) trims whitespace,
> collapses internal double spaces, and ignores case.

## Non-negotiable design rules (audit defensibility)

These are enforced in code, not just the UI:

1. **Blind count** — auditors never see system/expected quantity, rates, values,
   or prior-period figures. Enforced **server-side** in
   `server/src/lib/blindCount.js`, which strips those fields from every response
   sent to an auditor. Reports and system-stock endpoints are admin-only.
2. **Append-only entries** — `count_entries` is append-only. Counting an item at
   a second location creates a **new row**; totals are always
   `SUM(...) WHERE status='active'`.
3. **No deletion** — a wrong entry is **voided with a reason**, never deleted.
   Voided rows stay visible (struck through) and are excluded from totals.
4. **Zero is not blank** — "counted, found zero" and "not yet counted" are
   different. The auditor must type `0` explicitly.
5. **Full master shown** — every active item is listed so nothing is skipped.
6. **Audit trail** — every entry records who, when, and the location text.

---

## Prerequisites

- Node.js 18+ (tested on Node 22)
- PostgreSQL 14+

---

## 1. Install

```bash
# from the repo root
npm run install:all         # installs both server and client
# (or) cd server && npm install   &&   cd ../client && npm install
```

## 2. Environment variables

Copy the examples and edit as needed:

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env      # optional; only sets VITE_API_URL
```

Key server variables (`server/.env`):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | Secret for signing tokens (change in prod) |
| `JWT_EXPIRES_IN` | Access token lifetime (default `1h`, refreshed silently) |
| `JWT_REFRESH_EXPIRES_IN` | Refresh token lifetime (default `30d`) |
| `BCRYPT_ROUNDS` | Password hashing cost |
| `STORAGE_DRIVER` | `local` (dev) or `s3` (R2/S3 in prod) |
| `UPLOAD_DIR` / `PUBLIC_BASE_URL` | Local upload folder and its public URL |
| `S3_*` | Endpoint/bucket/keys when `STORAGE_DRIVER=s3` |
| `CLIENT_ORIGIN` | Allowed CORS origin (client dev server) |

Create the database first, e.g.:

```bash
createdb audix    # or: psql -c "CREATE DATABASE audix;"
```

## 3. Migrate and seed

```bash
npm run migrate    # applies server/migrations/*.sql
npm run seed       # loads demo data and prints login credentials
```

The seed prints credentials to the console:

```
ADMIN    username: admin    password: admin123
AUDITOR  username: rakesh   password: rakesh123   (Aerocity + CP)
AUDITOR  username: sunil    password: sunil123    (Aerocity)
```

It creates 4 sections, 8 categories, 2 stores, 3 users, 30 items (22 regular +
8 liquor), and **one open audit** with sample entries — including an item with
**two entries at different locations** (append-only) and a **voided entry**, so
the append-only and void behaviour is visible immediately.

## 4. Run

Two terminals (or use the root convenience script):

```bash
# terminal 1 — API on http://localhost:4000
npm run dev:server

# terminal 2 — client on http://localhost:5173
npm run dev:client

# …or both at once (needs the root devDependency `concurrently`):
npm install        # once, at repo root, to get concurrently
npm run dev
```

Open **http://localhost:5173**. Log in as an auditor on a narrow window (or
your phone on the same network) for the mobile flow, or as `admin` for the
desktop console.

---

## Photo handling

- **Desktop:** upload only (a file-picker button — no camera).
- **Mobile:** two buttons — **Take Photo**
  (`<input type="file" accept="image/*" capture="environment">`) and **Upload**.
  The camera button renders only on mobile (device detection in
  `client/src/lib/device.js`).
- Images are compressed client-side to a max **1200px** long edge before upload
  (`client/src/lib/image.js`); the server also re-compresses as a safety net
  (`sharp`). Accepts jpg, jpeg, png, webp. Only the resulting **URL** is stored.

> **HTTPS is required for camera capture in production.** Browsers only expose
> `capture`/`getUserMedia` on secure origins (`https://` or `localhost`). Serve
> the app over HTTPS so the **Take Photo** button works on real phones.

---

## Network safety net (not offline mode)

Cold stores and basements drop signal. To avoid losing typed data
(`client/src/lib/queue.js`):

- Each in-progress entry is mirrored to `localStorage` as the user types.
- On a failed submit the entry is **queued** and a banner shows
  "N entries pending — retrying".
- The queue auto-retries on reconnect and on a timer.
- The form is **never cleared** on a failed save.

This only prevents data loss; the app is otherwise online-only.

---

## Sessions and logout

Auditors count for hours in places with poor signal, so the session is built not
to drop:

- Login issues a short-lived **access token** plus a long-lived **refresh
  token**. The client refreshes silently (on a timer, on tab focus, and on any
  401), so an active user is never logged out.
- A **network failure is never treated as an auth failure.** `api.js` raises a
  distinct `NetworkError` for requests that never reached the server; only a
  rejected *refresh token* ends the session.
- The session survives reload and navigation (the profile is cached and the
  route guard waits for auth to finish loading).
- Logging out asks for confirmation, and never discards saved drafts.

## Photos from counting → item master

- Item has **no** master photo → the auditor's photo becomes the master
  immediately and is visible to everyone.
- Item **already has** a master photo → the new photo is saved with the count
  entry and queued in **Photo Review** (admin) showing current vs proposed side
  by side. The master only changes on approval.
- **Entry photos are evidence** — they stay attached to their count entry
  whether or not they become the master, and are never deleted or replaced.
- Master photo URLs carry a `photo_version` cache-buster so a new image shows
  immediately instead of serving a stale cached file.

## Reports vs the admin working view

- **Reports (the client deliverable) show TOTALS ONLY** — one line per item
  carrying its total, with no per-entry lines and no redundant "<item> Total"
  row. This applies to every report and every export.
- **The admin count-entry screen shows every individual entry** (quantity,
  location, user, timestamp), with voided entries struck through and excluded
  from the total. That is where an admin verifies how a total was arrived at.

The per-entry detail always exists in the database; it simply never appears in
a report given to the client.

## Reports

Admin only. Each exports to **Excel (.xlsx, SheetJS)** and **PDF (pdfkit)**.

- **R1** Physical Stock Summary — section-wise and category-wise qty & value
- **R2** Item Detail — per-entry breakdown with totals
- **R3** Liquor Report — sealed bottles and open ml kept **separate**
  (footnote: "Open bottle quantities are recorded by visual estimation.")
- **R4** Variance Report — physical − system, with % and status bands read from
  the **settings** table (liquor 2%/4%, others 1%/3% defaults — not hardcoded).
  While an audit is `open` the variance is **PROVISIONAL**: a banner reports how
  many items are still uncounted, an *Uncounted* column and an
  [All items | Counted only] filter are available, and any export is stamped
  `PROVISIONAL` in the file header and filename. The warning disappears once the
  auditor submits the count (audit status `submitted`).
- **R5** Consolidated — all stores, comparative aggregate variance
- **R6** Exception Report — voided entries, Not-Applicable items, items with
  multiple entries, zero-quantity entries, and items counted without a photo

---

## Swapping storage to R2 / S3 in production

Set `STORAGE_DRIVER=s3` and the `S3_*` variables in `server/.env`. The storage
interface (`server/src/lib/storage.js`) exposes a single `save()` method, so no
route code changes are needed. The database stores only the returned URL.

---

## Project layout

```
server/
  migrations/        SQL migrations + runner
  seed/              demo data seeder
  src/
    lib/             auth, storage, blind-count, csv, reports, exporters
    middleware/      auth + role + store-access guards
    routes/          auth, stores, users, items, audits, entries,
                     system-stock, settings, dashboard, reports, uploads
client/
  src/
    lib/             api, auth context, device, image compression, queue
    components/       PhotoInput, BottomSheet, ItemEntry, MobileHeader, ui
    pages/
      auditor/       M1–M8 mobile flow
      admin/         D1–D7 desktop console + reports
```

Every screen is usable at **380px** width.
