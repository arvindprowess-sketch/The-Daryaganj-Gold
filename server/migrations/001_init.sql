-- ═══════════════════════════════════════════════════════════════════════════
-- Audix Stock Audit — initial schema
-- Design rules baked in here:
--   * count_entries is APPEND-ONLY (no UPDATE of qty; void via status)
--   * NO DELETION (void with reason)
--   * ZERO IS NOT BLANK (qty is nullable in the model but an entry always
--     stores an explicit number; "not counted" == no active entry)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'auditor')),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stores (
  id         SERIAL PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  address    TEXT,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An auditor is mapped to one or more stores. Enforced on every endpoint.
CREATE TABLE IF NOT EXISTS user_stores (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, store_id)
);

CREATE TABLE IF NOT EXISTS sections (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS categories (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS items (
  id             SERIAL PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  category_id    INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  section_id     INTEGER REFERENCES sections(id) ON DELETE SET NULL,
  unit           TEXT NOT NULL DEFAULT 'Nos',
  is_liquor      BOOLEAN NOT NULL DEFAULT FALSE,
  bottle_size_ml INTEGER,
  rate           NUMERIC(12,2),          -- NEVER sent to auditors
  photo_url      TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audits (
  id          SERIAL PRIMARY KEY,
  store_id    INTEGER NOT NULL REFERENCES stores(id),
  audit_date  DATE NOT NULL,
  cutoff_time TEXT,                      -- free text cut-off e.g. "6:00 PM"
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_by  INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at   TIMESTAMPTZ
);

-- APPEND-ONLY. One item may have many active rows in one audit (multiple
-- locations). Totals are always SUM(...) WHERE status = 'active'.
CREATE TABLE IF NOT EXISTS count_entries (
  id            SERIAL PRIMARY KEY,
  audit_id      INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  item_id       INTEGER NOT NULL REFERENCES items(id),
  qty           NUMERIC(14,3),           -- non-liquor quantity (explicit 0 allowed)
  bottles       INTEGER,                 -- liquor sealed bottles
  open_ml       INTEGER,                 -- liquor open bottle ml (kept SEPARATE)
  location_text TEXT,
  remarks       TEXT,
  photo_url     TEXT,
  counted_by    INTEGER NOT NULL REFERENCES users(id),
  counted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  void_reason   TEXT,
  voided_by     INTEGER REFERENCES users(id),
  voided_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_count_entries_audit_item
  ON count_entries (audit_id, item_id);

-- Items an auditor has explicitly marked Not Applicable during submit.
CREATE TABLE IF NOT EXISTS audit_na (
  id         SERIAL PRIMARY KEY,
  audit_id   INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  item_id    INTEGER NOT NULL REFERENCES items(id),
  reason     TEXT NOT NULL,
  marked_by  INTEGER NOT NULL REFERENCES users(id),
  marked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (audit_id, item_id)
);

-- System (book) stock per audit. ADMIN ONLY. NEVER exposed to auditors.
CREATE TABLE IF NOT EXISTS system_stock (
  id         SERIAL PRIMARY KEY,
  audit_id   INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  item_id    INTEGER NOT NULL REFERENCES items(id),
  qty        NUMERIC(14,3) NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (audit_id, item_id)
);

-- Key/value settings, admin-editable. Tolerance thresholds live here.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Default tolerance thresholds (percent). Variance status bands read these.
INSERT INTO settings (key, value) VALUES
  ('tolerance_liquor_ok',    '2'),
  ('tolerance_liquor_warn',  '4'),
  ('tolerance_general_ok',   '1'),
  ('tolerance_general_warn', '3')
ON CONFLICT (key) DO NOTHING;
