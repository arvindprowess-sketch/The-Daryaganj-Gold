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

## Liquor: bottles and open ml are both shown

Sealed bottles and loose millilitres are counted separately and never combined.
Every list badge shows **both**, via `client/src/lib/liquor.js`, so loose stock
is visible without opening the item:

| Counted | Badge |
| --- | --- |
| 3 bottles, 630 ml | `3 btl · 630 ml` |
| 3 bottles, 0 ml | `3 btl` |
| 0 bottles, 630 ml | `630 ml` |
| nothing | `0 btl` |

The zero half is dropped rather than printed, so the badge stays on one line
next to the item name on a 380px phone. Mobile item list and desktop count
entry use the same helper.

## Non-negotiable design rules (audit defensibility)

These are enforced in code, not just the UI:

1. **Blind count** — auditors never see system/expected quantity, rates, values,
   or prior-period figures. Enforced **server-side** in
   `server/src/lib/blindCount.js`, which strips those fields from every response
   sent to an auditor. Reports and system-stock endpoints are admin-only.
   > The scrubber rebuilds **plain objects only**. `node-postgres` returns every
   > `TIMESTAMPTZ` as a `Date`, and a `Date` has no own enumerable properties —
   > rebuilding one from `Object.entries()` yields `{}`, which is how every
   > auditor timestamp once serialised as `{}` and rendered "Invalid Date". Any
   > new class instance (a `Buffer`, say) would have gone the same way. Keep the
   > `isPlainObject` guard when editing that file.
2. **Append-only entries** — `count_entries` is append-only. Counting an item at
   a second location creates a **new row**; totals are always
   `SUM(...) WHERE status='active'`.
3. **No deletion** — a wrong entry is **voided with a reason**, never deleted.
   Voided rows stay visible (struck through) and are excluded from totals.
4. **Zero is not blank** — "counted, found zero" and "not yet counted" are
   different. The auditor must type `0` explicitly.
5. **Full master shown** — every active item is listed so nothing is skipped.
6. **Audit trail** — every entry records who, when, and the location text.

> **Submitting does not require a complete count.** The master is shared across
> stores and one outlet stocks only a subset of it, so an uncounted item is the
> normal case, not an error. The auditor confirms three figures — items in the
> master, counted, not counted — and only counted items are submitted. **No
> zero-quantity entries and no `audit_na` rows are created**, because "not
> counted" and "counted and found zero" must stay distinguishable (rule 4).
> Nothing is deleted on submit either; data is only ever removed by an admin
> through Data management. What stops an uncounted item disappearing is the
> variance report — see [Which items appear, and why](#which-items-appear-and-why).

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
npm run seed       # hierarchy only — NO users, NO items, NO demo data
```

**`npm run seed` never creates demo data.** It loads only the super categories
and categories, so running it on a live deployment is safe.

### Going live (production)

First set the three variables the API refuses to start without — see
[Production configuration](#production-configuration) — then:

```bash
npm run migrate
npm run seed                                   # hierarchy only
npm run create:admin -- --username arvind --name "Arvind"
```

`create:admin` makes the first REAL admin (`is_demo = false`). Omit
`--password` and a strong one is generated and printed once. That is the whole
production setup — the database contains **zero demo rows**.

Then sign in and load the real item master from Item master → CSV import.

### Demo data (development only)

```bash
npm run seed:demo    # demo users, sample store, sample master, audit, entries
```

This is the ONLY thing that creates demo data, and it **refuses to run when
`NODE_ENV=production`** (exit code 1; `--force-seed` overrides). Everything it
creates is flagged `is_demo = true` so it can be removed exactly.

## 4. Run (development)

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

## 5. Deploying as one service

In production the API also **serves the built client from the same origin**.
The client calls the API with relative URLs (`fetch('/api' + path)` in
`client/src/lib/api.js`), so there is no API base URL to point a separately
hosted frontend at — same-origin is the only supported shape.

The root `package.json` carries both scripts a host needs, so a platform that
auto-detects Node conventions needs no manual build or start command:

```bash
npm run build     # installs both workspaces and builds client/dist
npm start         # boots the API, which also serves that build
```

- `server/src/index.js` serves `client/dist` and falls back to `index.html` for
  any path outside `/api/` and `/uploads/`, so client-side routes survive a hard
  refresh and a pasted deep link. Hashed assets are cached for a year;
  `index.html` never is, or a redeploy leaves browsers loading a bundle that no
  longer exists.
- The block is guarded by an `index.html` existence check, so in development —
  where Vite serves the client and no build exists — it stays inert and the API
  runs exactly as before. `CLIENT_DIST` overrides the location if the build
  lands somewhere else.
- `PORT` is read from the environment (`process.env.PORT || 4000`), which is
  what Railway, Render and Fly inject. Do not set it yourself.
- **`--include=dev` in the build script matters.** Vite and Tailwind are
  `devDependencies`, and with `NODE_ENV=production` set `npm install` omits them
  and the build fails with `vite: not found`.
- **`STORAGE_DRIVER=s3` is required** on any platform with an ephemeral
  filesystem: the local driver writes into the container and every photo is lost
  on redeploy.
- `CLIENT_ORIGIN` still has to be a real origin even though the app is
  same-origin — the production guard refuses `*` and the server will not start.

Set the variables in [Production configuration](#production-configuration)
before the first boot — the server exits rather than start without them.

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

Admin only. Each exports to **Excel (.xlsx, exceljs)** and **PDF (pdfkit)**.

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
- **R4** Variance Report — see [Variance and value](#variance-and-value) below
- **R5** Consolidated — all stores, comparative aggregate variance, plus a
  **super-category-level comparison across stores**
- **R6** Exception Report — voided entries, Not-Applicable items, items with
  multiple entries, zero-quantity entries, items counted without a photo, items
  with no system figure, and **items with system stock that were never counted**

### Variance and value

R4 is physical − system, with % and status bands read from the **settings**
table (liquor 2%/4%, others 1%/3% defaults — not hardcoded).

#### Which items appear, and why

The item master is shared across every store while a single outlet stocks only
a subset of it, so "not counted" cannot mean the same thing everywhere. Four
cases, and only one of them is silent:

| | Counted | Not counted |
| --- | --- | --- |
| **System row exists** | (a) ordinary variance | (c) **full shortage, flagged `NOT COUNTED`** |
| **No system row** | (b) `NO SYSTEM DATA` — a data gap, excluded from variance totals | (d) not stocked here — **off the table**, header count only |

**(c) is the one that matters.** The system says stock is there and nobody
counted it. Physical is treated as 0, so it carries its **full rupee value into
the variance totals and the grand total** — it must never quietly disappear.
The `NOT COUNTED` flag in the **Counted** column is what separates it from an
item an auditor stood in front of and entered as zero: both read as shortages,
for completely different reasons. The report header states the count and the
total rupee exposure, and R6 gives them their own section to chase up.

**(d)** is excluded from the table entirely — listing several hundred items the
outlet never stocked would bury every real finding. They are still accounted
for, as a header line: *"182 master items neither counted nor present in system
stock — not stocked at this outlet."*

**The rupee impact is the point of the report**, so every row carries three
separate money figures rather than one:

| Field | Meaning |
| --- | --- |
| `physical_value` | `physical_qty × rate` — what is actually on the shelf |
| `system_value` | `system_qty × rate` — what the books say should be there |
| `variance_value` | `variance × rate` — **negative = shortage, positive = excess** |

Columns, on screen and in both exports:

```
Super Category | Category | Item Name | Unit | Rate | Physical |
System | Variance | % | Physical Value | Variance Value | Counted | Status
```

All numeric columns are right-aligned.

**A missing rate is never treated as zero.** Where `rate` is null all three
money figures are null and render as `—`; the quantity variance is still shown,
because that part is still real. Subtotals sum only the items that have a rate
and count the rest in `no_rate`, so a shortfall in the master can never quietly
understate a total. The report header states it plainly —
*"42 items have no rate — value figures exclude them"* — with a
**[All] [With rate] [No rate]** filter to isolate them and a link to the item
master. **Admin → System Readiness** carries the same check, *Items missing a
rate*.

**Subtotals** appear at category level, super-category level and as a
**GRAND TOTAL** (matching R1). Every one of them carries the same figures in the
same columns — items, physical, system, variance, variance %, physical value,
variance value — so a column can be read straight down from an item line to the
grand total. They all come from one accumulator in `reports.js`, so the grand
total can never be computed on a different basis from the rows above it. The
ungrouped view carries the same totals in its totals bar.

The **group-and-subtotal** toggle now defaults to **ON**: the subtotals are the
report, and off by default they were hidden behind a checkbox with no reason to
find it.

Filters: super category, category,
**[All | Counted | Not counted with system stock]**,
[All | With system data | No system data], [All | With rate | No rate]. Every
one applies to the on-screen view and to the Excel and PDF exports alike.

While an audit is `open` the variance is **PROVISIONAL**: a banner reports how
many items are still uncounted, and any export is stamped `PROVISIONAL` in the
file header and filename. The warning disappears once the auditor submits the
count (audit status `submitted`).

> **Value figures are admin-only.** `rate`, `physical_value`, `system_value` and
> `variance_value` are all in the `FORBIDDEN_FOR_AUDITOR` set in
> `blindCount.js`, and every report endpoint is admin-only — an auditor
> requesting R4 gets a 403. This is design rule #1 and is enforced server-side.

## Finding an item while counting

Both counting screens — the auditor's mobile item list and the admin
count-entry table — have a **search box** that filters by item name as you type
(debounced, case-insensitive, matches any part of the name). Search works
**together with** the category filter and the [All | Not counted | Counted]
filter. On mobile the search box stays **sticky** at the top while the list
scrolls.

---

## System stock — import, correct, remove, trace

Admin only; never exposed to the auditor role (every endpoint is 403 for an
auditor, including the import history and activity log).

A wrong file imported against the wrong audit used to produce a complete but
entirely wrong variance report, with nothing to show where the figures came
from and no way to undo it. That is now closed off on four fronts.

### Correcting figures

- **Edit one figure inline** — the commonest correction; no re-import needed.
  The change is logged with its old and new values, and the row is marked
  *hand-corrected* (it is no longer attributed to the import file).
- **Delete a single row** — for one wrong figure rather than the whole file.
- **Clear all system stock** — requires typing `CLEAR SYSTEM STOCK`, and states
  exactly what will go ("system stock for 594 items, imported … by …").
  **Physical count entries are never touched.**

The variance report recalculates immediately after any of these.

### Wrong-file guards

Before anything is written, the preview states the audit, the file, the row
count, and **what will be replaced**, then challenges suspicious imports:

| Guard | Behaviour |
|---|---|
| **Store mismatch** — every row carries a `LOC` that isn't this audit's store | **Blocked.** Override needs `IMPORT ANYWAY` typed *plus* a reason, both recorded. Re-checked server-side, so the UI cannot wave it through. |
| **Low match rate** — under 80% of rows match the master | Warning + explicit acknowledgement |
| **Coverage gap** — over 20% of master items absent from the file | Warning + explicit acknowledgement |
| **Duplicate import** — same filename already imported for this audit | Warning + explicit acknowledgement |

The **not matched** and **in master, not in file** lists are always shown in
full and are downloadable as CSV. Neither is ever hidden.

A replace runs as **clear-then-insert inside one transaction**, so a failed
import can never leave the audit with half the old data and half the new.

### Provenance and history

Every import records filename, row/matched/unmatched counts, who and when. A
superseded import is marked `replaced` (never deleted) so a re-import is always
visible; a cleared one is marked `cleared`. Clears, replacements and
single-figure corrections are written to `activity_log` with before/after
values. Both are shown on the system stock screen, and the source file, import
time, importer and coverage appear in the **variance report header and in every
variance export**.

### No system figure ≠ zero

- *system says 0, physical found 5* → a genuine excess, a real variance
- *no system row for this item* → a **data gap**, not a variance

A missing row is `NULL`, never zero. Such items show the status
**`NO SYSTEM DATA`**, carry no percentage, are **excluded from variance totals
and from the overall variance %**, are counted separately in the exception
report, and can be isolated with the
**[All] [With system data] [No system data]** filter.

If **no** system stock exists at all, the variance report does not render a
table of 100% shortages — it shows "No system stock has been imported for this
audit" with a link to import, so an empty import is never mistaken for a total
shortage.

### Accepted file format

The importer accepts **the client's own system export directly**:

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

## Security

### Production configuration

The API **refuses to start** when `NODE_ENV=production` and any of these is
still on a development value. It prints what is wrong and exits with code 1
rather than serving a single request on a known-compromisable configuration.

| Variable | Rejected when | Why |
| --- | --- | --- |
| `JWT_SECRET` | unset, equal to the `dev-insecure-secret-change-me` fallback in `config.js`, shorter than 32 characters, or still a recognisable placeholder (`change-me…`, `your-secret…`, `example…`) | Both fallbacks are **public in this repository**. Anyone holding the value can mint a valid admin token. |
| `DATABASE_URL` | unset or equal to `postgres://audix:audix@localhost:5432/audix` | The default carries the credentials `audix/audix`. |
| `CLIENT_ORIGIN` | `*` | A wildcard reflects whatever `Origin` the browser sends, which defeats CORS entirely when requests carry a token. Give an explicit comma-separated list. |

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Outside production the same problems are printed as a warning and the server
runs — development is meant to work with no setup.

All three appear on **Admin → System Readiness**. In production a failure is
badged *blocks startup*; in development it shows as an amber advisory ("Required
before deploying to production") and does not count against "ready to count".
The `DATABASE_URL` password is redacted everywhere it is displayed or logged.

### Rate limiting

`express-rate-limit`, on the authentication endpoints **only**:

| Endpoint | Limit | Why |
| --- | --- | --- |
| `POST /api/auth/login` | 10 per IP per 15 min | The one place an attacker can guess their way in. |
| `POST /api/auth/refresh` | 60 per IP per 15 min | Called automatically by every open tab, so the ceiling is far higher; it exists to stop a stolen refresh token being ground against the endpoint. |

Exceeding a limit returns **429** with a plain-English message in the same
`{ error }` shape as everything else, so the client shows it like any other
message rather than "Request failed (429)".

**Counting endpoints are deliberately not limited.** An auditor working through
618 items submits entries as fast as they can type; throttling that would break
a count night. Verified: 60 consecutive `POST /audits/:id/entries` all return
201.

> **Operational note.** The limit is per IP. If the whole firm counts from one
> office behind a single NAT address, ten mistyped passwords between them will
> lock out everyone at that address for 15 minutes. Auditors on mobile data each
> have their own address and are unaffected. Raise the login limit in
> `server/src/middleware/rateLimit.js` if that turns out to bite.

Behind a reverse proxy (Render, Fly, nginx, Cloudflare) the app sets
`trust proxy = 1` in production, so `req.ip` is the client address rather than
the proxy's — otherwise the limiter would treat the entire firm as one client.
One hop only: trusting the whole `X-Forwarded-For` chain would let a client
spoof its own address and walk straight past the limiter.

### Failed sign-ins are in the audit trail

Every rejected login writes an `activity_log` row: the username tried, the
reason (`unknown_username`, `wrong_password`, `account_inactive`), the source
IP and the user agent. **The password is never recorded.** The HTTP response
stays identical for every case so it cannot be used to discover which usernames
exist — only the log distinguishes them.

### Security headers

`helmet` with its defaults: CSP, `X-Content-Type-Options: nosniff`,
`X-Frame-Options`, `Referrer-Policy`, HSTS.

One deliberate adjustment: photos are served from the object-storage host, which
the default `img-src 'self'` would block. Rather than turning CSP off, the host
is allow-listed — `img-src` is built from `S3_PUBLIC_URL` and `S3_ENDPOINT`, so
configuring storage automatically configures the policy:

```
img-src 'self' data: blob: https://photos.example.com https://<account>.r2.cloudflarestorage.com
```

### Dependencies

`npm audit` reports **0 vulnerabilities** in `server/`.

- **sharp** upgraded to `^0.35.3` — `<0.35.0` inherited four libvips CVEs
  (GHSA-f88m-g3jw-g9cj). Both upload paths were re-verified end to end: a
  1400×900 PNG through `POST /api/upload` and through bulk photo upload comes
  back a 1200×771 JPEG, stored and served correctly.
- **xlsx (SheetJS) removed, replaced with exceljs.** `xlsx@0.18.5` carried two
  high-severity advisories — prototype pollution (GHSA-4r6h-8v6p-xvw6) and a
  ReDoS (GHSA-5pgg-2g8v-p4x9) — with **no patched release available**, so
  upgrading was not an option. Only `buildWorkbook()` used it. All six Excel
  reports were re-verified after the swap, including multi-sheet workbooks and
  the PROVISIONAL banner rows.
- **uuid** is pinned via an `overrides` entry to `^11.1.1`. exceljs depends on
  `uuid@8`, which carries a moderate advisory. exceljs only calls `v4()` and the
  advisory affects `v3/v5/v6` with a `buf` argument, so it was not reachable —
  the override clears it regardless.

## Data management and production safety

Admin only, enforced server-side. Every destructive operation requires its exact
confirmation phrase **in the request body** — the server validates it
independently, so the UI cannot wave anything through. Multi-table deletions run
in one transaction, and object-storage deletion happens only **after** that
transaction commits, so a storage failure can never orphan a row.

| Action | Phrase | Guard |
|---|---|---|
| Delete all items | `DELETE ALL ITEMS` | **Blocked** while any count entry exists |
| Replace master via CSV | `REPLACE ITEM MASTER` | Same block; preview first |
| Delete an audit | `DELETE THIS AUDIT` | Removes its entries and system stock only |
| Clear an audit's entries | `CLEAR ALL ENTRIES` | Audit stays open, resets to zero counted |
| Delete demo data | `DELETE DEMO DATA` | Matches on the `is_demo` flag, never on names |

### CSV import modes

The import screen offers three explicit modes, with the impact of each shown
before committing ("412 items will be updated, 206 created, 0 deleted"):

- **Add new items only** — existing items untouched
- **Add new and update existing** — matched by item name
- **Replace entire master** — delete everything, then import (typed
  confirmation, and blocked while count entries exist)

**An item is never deleted silently as a side effect of an import.** Only the
explicit replace mode removes anything.

### Import feedback

Both imports — item master and system stock — report their outcome in a banner
that **stays until it is dismissed**. A bulk change to master data is not
something to announce in a toast that fades before the admin looks back at the
screen.

- **Success** — "Import successful — 618 items imported, 0 skipped.", plus the
  filename, the row count in the file, and any super categories or categories
  the import created.
- **Partial** — "Import completed with issues — 571 imported, 23 not matched.",
  with a button to list the rows that were left out (and, for system stock, to
  download them as CSV).
- **Failure** — the actual reason, never a generic message:
  - `Import failed — file could not be read. "stock.xlsx" is an Excel workbook
    (.xlsx) or a zip archive. Open it in Excel and choose File → Save As → CSV.`
  - `Import failed — required column 'item_name' is missing. Columns found: …`
  - `Import failed — no rows found in file. "master.csv" has a header row but no
    data rows.`
  - `Import failed — 2 row(s) have errors. row 7 (Old Monk Rum):
    bottle_size_ml is required when is_liquor is TRUE · …`

While an import runs, a progress indicator names the file, and both the file
input and the commit button are disabled so it cannot be submitted twice. On
success the list behind the panel refreshes immediately — no manual reload.

The commit endpoints run the same checks as the preview, so a file the preview
would reject can never be committed by calling the API directly. Excel's
"CSV UTF-8" byte-order mark is stripped before parsing (left in place it becomes
part of the first header name and `item_name` silently stops matching).

### Soft delete

An item that has **ever been counted** is never hard deleted — that would orphan
historical audit records. Deleting it sets `is_active = false`: it disappears
from counting screens and new audits, stays visible in historical reports, and
can be reactivated. The item master has an **[Active] [Inactive] [All]** filter.
Only items with zero count entries anywhere are removed permanently.

### Deleting users and stores

The same rule, applied to accounts and outlets. Admin → Stores & Users has a
Delete action on both tabs, an **[Active] [Inactive] [All]** filter, and
Reactivate for anything deactivated. Everything is admin-only and enforced
server-side; the screen asks the server what a delete would do first
(`GET /users/:id/impact`, `GET /stores/:id/impact`) so the confirmation dialog
states the real outcome instead of a guess.

**Users**

| Situation | What happens |
| --- | --- |
| Has count entries (or N/A marks, or photo submissions) | `is_active = false`. Entries keep their `counted_by` reference, so historical reports still show the name. The account can no longer sign in — `/auth/login` and `/auth/refresh` both reject an inactive user, so a live session ends within one access-token lifetime. |
| No history anywhere | Hard deleted, together with its store assignments. Nullable "who touched this last" references (audit creator, voider, importer) are cleared first. |
| Your own account | Refused, whatever the history. Another admin has to do it. |

**Stores**

| Situation | What happens |
| --- | --- |
| Has any audit against it | `is_active = false`. Those audits, their entries and their reports stay intact. |
| No audits | Hard deleted. |
| Either way | The user-to-store mappings are removed — the store is no longer to be counted, so no auditor stays assigned to it. Reactivating therefore needs the auditors reassigned, and the response says so. |

`GET /stores` returns **active stores only** by default, for every caller. That
default is what keeps a deleted store out of the audit-creation dropdown and off
the auditor's screens; the management screen asks for `?active=inactive` or
`?active=all` explicitly. Reports join `stores` and `users` directly, so an
inactive store or user still reads correctly in historical output.

The activity log keeps its attribution across a hard delete: `logActivity`
snapshots the acting user's name into `activity_log.user_label` at write time,
and the log reads `COALESCE(users.name, user_label)`.

### Demo data

`is_demo` marks every row created by `seed:demo` (users, stores, items, audits,
count entries). Anything created through the UI or a CSV import is `false`, so
cleanup is exact rather than guesswork. While any demo record exists the admin
console shows a persistent banner with the counts — **including in production**,
where the API also logs a prominent warning at startup. The account performing
the deletion is never removed (it would lock the admin out mid-operation), and
the response says so.

### Activity log

Every destructive action — master deletion and replacement, audit deletion,
entry clearing, demo cleanup, item deactivation, password changes — is written
to `activity_log` with who, when, how many records and a JSON detail payload.
It is exposed read-only on Admin → Data management, newest first, with no
delete endpoint: an audit firm must be able to answer "who removed that data
and when".

### System Readiness

Admin → System Readiness is the pre-count checklist. It reports demo data
present, users still on a seeded default password, item master loaded, items
missing a photo, liquor items missing `bottle_size_ml`, **object storage
reachable via a real write-then-delete probe**, and audits left open from a
previous session. Run it before the pilot count and before each count night.

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
