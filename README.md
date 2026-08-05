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

## Item hierarchy

The app mirrors the client's own inventory master, because our reports have to
reconcile against their system:

```
super_categories  →  categories  →  items
```

Both levels are **ordinary admin-manageable rows**, not hardcoded constants —
the client can add a super category or a category at any time (Item master →
CSV import creates unknown levels, or manage them directly via the meta API).

The seeded structure uses the client's names **exactly as they write them**
(same spelling, same case) so reports reconcile without manual translation:

| Super category | Categories |
|---|---|
| `FOOD` | PROVISION, SEMI FINISHED, VEGETABLES & FRUITS, BUTCHERY, DAIRY |
| `NON FOOD` | CONSUMABLE, PRINTABLE, HK, CHEMICAL, PACKAGING |
| `CCG` | BAR WARE, BAR GLASSWARE, CROCKERY, CUTLERY, SERVICE WARE |
| `LIQUOR` | LIQUOR |
| `BEVERAGES` | BEVERAGES |

**Where each level is visible**

- **Auditors (mobile) see SUPER CATEGORIES ONLY** — five cards, and tapping one
  goes straight to the item list. Categories are never a navigation level on
  the phone; they would clutter the flow and confuse the counter.
- **Categories are stored on every item** and appear throughout the admin
  console and in **every report**.

## Unit is plain text

Unit is a label that comes from the client's master and is displayed **exactly
as uploaded, character for character**. There is no dropdown, no reference
table, no autocomplete, and no normalisation beyond stripping leading/trailing
whitespace. Strings such as `CAN (5 LTR)`, `BTL (500 ML)`, `TIN (850 GM)`,
`POR`, `BOT-680G` and `Pkt (50 pcs)` all round-trip unchanged, and an
unrecognised unit **never** rejects a CSV row.

The auditor never chooses or edits a unit — it is read-only on every counting
screen. An admin can edit it as free text on the item master.

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
AUDITOR  username: rakesh   password: rakesh123   (M3M)
AUDITOR  username: sunil    password: sunil123    (M3M)
```

It creates the client's hierarchy (5 super categories, 17 categories), the
**M3M** store, 3 users, the **618-item master (64 liquor)**, and **one open
audit** with sample entries — including an item with **two entries at different
locations** (append-only) and a **voided entry**, so the append-only and void
behaviour is visible immediately.

### Seeding the real item master

The seed prefers the client's own export. Drop it at:

```
server/seed/Item_Master_Import_Ready.csv
```

with columns `item_name, super_category, category, unit, is_liquor,
bottle_size_ml, rate`, then run `npm run seed`. It is used verbatim — units
included.

If that file is **absent**, the seed generates a **stand-in master** at the same
volume and distribution (FOOD 299 · NON FOOD 128 · CCG 70 · LIQUOR 64 ·
BEVERAGES 57 = 618) so the app can be exercised at realistic scale, and prints a
warning saying so. Those names are placeholders, **not client data**.

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

Every report carries **both hierarchy levels**, in a standard column order:

```
Super Category | Category | Item Name | Unit | ... figures ...
```

- **R1** Physical Stock Summary — grouped super category → category, with a
  subtotal per category, a subtotal per super category, and a grand total
- **R2** Item Detail — one line per item with its total (totals only)
- **R3** Liquor Report — structure unchanged; sealed bottles and open ml stay
  **separate** and are never combined. Super category and category added for
  consistency. (Footnote: "Open bottle quantities are recorded by visual
  estimation.")
- **R4** Variance Report — physical − system, with % and status bands read from
  the **settings** table (liquor 2%/4%, others 1%/3% defaults — not hardcoded).
  Includes Super Category and Category, **filters on both levels**, and a
  **group-and-subtotal** option producing subtotals at category and super
  category level; all apply to the on-screen view and to the Excel/PDF exports.
  While an audit is `open` the variance is **PROVISIONAL**: a banner reports how
  many items are still uncounted, an *Uncounted* column and an
  [All items | Counted only] filter are available, and any export is stamped
  `PROVISIONAL` in the file header and filename. The warning disappears once the
  auditor submits the count (audit status `submitted`).
- **R5** Consolidated — all stores, comparative aggregate variance, plus a
  **super-category-level comparison across stores**
- **R6** Exception Report — voided entries, Not-Applicable items, items with
  multiple entries, zero-quantity entries, and items counted without a photo

## Finding an item while counting

Both counting screens — the auditor's mobile item list and the admin
count-entry table — have a **search box** that filters by item name as you type
(debounced, case-insensitive, matches any part of the name). Search works
**together with** the category filter and the [All | Not counted | Counted]
filter. On mobile the search box stays **sticky** at the top while the list
scrolls.

---

## System stock import

Admin only; never exposed to the auditor role. The importer accepts **the
client's own system export directly**:

```
LOC, Super Category Name, Category Name, Item Name, Unit, Closing Qty
```

- `Item Name` → the item (this is what matching is done on)
- `Closing Qty` → the system quantity
- `LOC` is ignored
- `Super Category Name` / `Category Name` are used only to help identify
  unmatched rows in the preview

Names are compared with leading/trailing spaces trimmed and internal double
spaces collapsed **on both sides**, so the trailing and doubled spaces in the
client's export never cause a false mismatch. The preview reports matched /
unmatched counts before anything is written, unmatched names are listed
explicitly rather than ignored, and a re-import **replaces** that audit's system
stock behind a confirmation prompt.

For liquor the single `Closing Qty` column is read as the sealed-bottle count;
optional `system_bottles` / `system_open_ml` columns keep bottles and ml
separate, exactly as the physical count does.

## Performance at 618 items per store

- The mobile item list is **virtualised** — roughly 16 rows are mounted for a
  299-item super category instead of all 299.
- Search is **debounced** (250 ms) and item name is indexed (`pg_trgm` GIN
  index plus a unique `lower(name)` index).
- Super-category and category progress counts are computed by a **single
  aggregate query** each (~0.6 ms measured), never by loading every item.
- Reports and exports over 618 rows complete in well under a second.

## Photo storage (object storage, never the database)

**Image files are never stored in the database — not as binary, not as base64.**
Photos go to object storage and the database holds only the public **URL
string**. Everything goes through one narrow interface
(`server/src/lib/storage.js`, a single `save()` method), so the provider is
swapped by **changing environment variables only** — no code change.

### Drivers

| `STORAGE_DRIVER` | Used for | Where files land |
|---|---|---|
| `local` (default) | development fallback | `server/<UPLOAD_DIR>/`, served at `/uploads` |
| `s3` | production | Cloudflare R2, AWS S3, MinIO — any S3-compatible bucket |

### Environment variables

```bash
STORAGE_DRIVER=s3            # local | s3

# Required when STORAGE_DRIVER=s3
S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
S3_BUCKET=audix-photos
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
S3_PUBLIC_URL=https://photos.example.com   # public bucket or CDN domain
S3_REGION=auto                             # R2 uses "auto"
S3_FORCE_PATH_STYLE=true

# Used by the local driver only
UPLOAD_DIR=uploads
PUBLIC_BASE_URL=http://localhost:4000
```

`S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_PUBLIC_BASE_URL` are still
accepted as aliases, so existing deployments keep working.

### Filenames

Objects are keyed `YYYY-MM-DD/<item-name-slug>-<hash>.jpg`, e.g.
`2026-08-04/refined-oil-9f3a1c2b.jpg`. The slug makes stored files
recognisable; the short random hash guarantees **two uploads never collide**,
even for the same item on the same day.

Images are compressed client-side to a max **1200px** long edge before upload
(`client/src/lib/image.js`), and the server re-compresses with `sharp` as a
safety net.

### Migrating photos already held in the database

If an earlier deployment embedded images in Postgres (a `data:image/...;base64`
URI or a bare base64 blob in `photo_url`), move them out with:

```bash
cd server
npm run migrate:photos -- --dry-run   # report only, writes nothing
npm run migrate:photos                # perform the move
```

Set `STORAGE_DRIVER` (and the `S3_*` variables) **before** running it so files
land where you want them. The script is **idempotent** — rows already holding a
plain URL are skipped, so it is safe to re-run. It covers master photos
(`items`), entry evidence photos (`count_entries`), and pending proposals
(`photo_reviews`), and bumps `photo_version` so clients pick up the new URL
instead of a cached image.

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
