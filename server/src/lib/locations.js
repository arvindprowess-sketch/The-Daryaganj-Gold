// ═══════════════════════════════════════════════════════════════════════════
// The global location list.
//
// One list for every store. The five places exist in every outlet, so scoping
// them per store would mean maintaining five copies of the same list and
// reports whose columns could not be compared between stores.
//
// The report reads its columns from here rather than hardcoding names, so
// renaming "FOH/Bar" or adding a sixth place changes the report with no code
// change.
// ═══════════════════════════════════════════════════════════════════════════
import { query } from '../db.js';

export async function activeLocations() {
  const { rows } = await query(
    `SELECT id, name, sort_order FROM locations
      WHERE is_active ORDER BY sort_order, id`
  );
  return rows;
}

export async function allLocations() {
  const { rows } = await query(
    `SELECT l.id, l.name, l.sort_order, l.is_active,
            (SELECT count(*)::int FROM count_entries ce WHERE ce.location_id = l.id) AS entry_count
       FROM locations l ORDER BY l.sort_order, l.id`
  );
  return rows;
}

// The columns a report shows: every ACTIVE location, plus any INACTIVE one
// this audit actually has quantity in.
//
// A deactivated location must not erase history. If an auditor counted 40 kg
// in "Dry Store" and the admin later retires it, the report still has to show
// those 40 kg or the total stops reconciling — so the column stays for as long
// as the data does, and disappears on its own once nothing references it.
export async function reportLocations(auditId, submissionId = null) {
  const { rows } = await query(
    `SELECT l.id, l.name, l.sort_order, l.is_active
       FROM locations l
      WHERE l.is_active
         OR EXISTS (SELECT 1 FROM count_entries ce
                     WHERE ce.location_id = l.id AND ce.audit_id = $1)
         OR ($2::int IS NOT NULL AND EXISTS (
               SELECT 1 FROM submission_entries se
                WHERE se.location_id = l.id AND se.submission_id = $2))
      ORDER BY l.sort_order, l.id`,
    [auditId, submissionId]
  );
  return rows;
}

// Rejects an entry whose location is missing, unknown or retired. The UI
// disables Save without one; this is the half that cannot be bypassed.
export async function resolveLocation(locationId) {
  if (locationId == null || locationId === '') {
    return { error: 'Location is required' };
  }
  if (!/^\d+$/.test(String(locationId))) {
    return { error: 'Invalid location' };
  }
  const { rows } = await query(
    'SELECT id, name, is_active FROM locations WHERE id = $1', [locationId]
  );
  if (!rows[0]) return { error: 'Invalid location' };
  if (!rows[0].is_active) return { error: `Location "${rows[0].name}" is no longer in use` };
  return { location: rows[0] };
}
