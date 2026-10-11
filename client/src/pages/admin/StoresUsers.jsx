import { useEffect, useState, useCallback } from 'react';
import { storesChanged } from '../../lib/mode.js';
import { api } from '../../lib/api.js';
import { Spinner } from '../../components/ui.jsx';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useAuth } from '../../lib/auth.jsx';
import PasswordField from '../../components/PasswordField.jsx';

// ═══════════════════════════════════════════════════════════════════════════
// D2 — Stores & users.
//
// Deleting either one follows the rule already used for items:
//   referenced by history → DEACTIVATE (kept in reports, gone from dropdowns)
//   never referenced      → hard delete
// The server decides which, so the screen asks it first and shows the real
// outcome in the confirmation rather than guessing.
// ═══════════════════════════════════════════════════════════════════════════
export default function StoresUsers() {
  const [tab, setTab] = useState('stores');
  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Stores &amp; Users</h1>
      <div className="flex gap-2 mb-4">
        <button className={tab === 'stores' ? 'chip-on' : 'chip-off'} onClick={() => setTab('stores')}>Stores</button>
        <button className={tab === 'users' ? 'chip-on' : 'chip-off'} onClick={() => setTab('users')}>Users</button>
      </div>
      {tab === 'stores' ? <Stores /> : <Users />}
    </div>
  );
}

// [Active] [Inactive] [All]
function ActiveFilter({ value, onChange }) {
  return (
    <div className="flex gap-2">
      {[['active', 'Active'], ['inactive', 'Inactive'], ['all', 'All']].map(([k, label]) => (
        <button key={k} className={value === k ? 'chip-on' : 'chip-off'}
                onClick={() => onChange(k)}>{label}</button>
      ))}
    </div>
  );
}

const InactiveBadge = () => (
  <span className="ml-2 chip bg-slate-100 text-slate-500 border-slate-200">inactive</span>
);

function Stores() {
  const [stores, setStores] = useState(null);
  const [f, setF] = useState({ code: '', name: '', address: '', inventory_mode: 'cafe' });
  const [err, setErr] = useState('');
  const [active, setActive] = useState('active');
  const [confirmDel, setConfirmDel] = useState(null); // { store, impact }
  const toast = useToast();

  const load = useCallback(
    () => api.get(`/stores?active=${active}`).then(setStores), [active]);
  useEffect(() => { load(); }, [load]);

  async function add() {
    setErr('');
    try { await api.post('/stores', f); setF({ code: '', name: '', address: '', inventory_mode: 'cafe' }); load(); storesChanged(); }
    catch (e) { setErr(e.message); }
  }
  // A store's type decides how it is counted: a cafe by super category with a
  // blind count, a warehouse batch by batch with each batch's book quantity.
  // The app follows it automatically — nobody picks a mode at login.
  async function setMode(s, mode) {
    if (mode === s.inventory_mode) return;
    if (s.audit_count > 0 && !window.confirm(
      `Change "${s.name}" to ${mode === 'warehouse' ? 'Warehouse' : 'Cafe'}? `
      + 'Its audits will open in that layout from now on. Entries already recorded are not changed.')) return;
    try { await api.put(`/stores/${s.id}`, { inventory_mode: mode }); load(); storesChanged(); }
    catch (e) { setErr(e.message); }
  }
  async function toggle(s) { await api.put(`/stores/${s.id}`, { is_active: !s.is_active }); load(); }

  // Ask the server what deleting would actually do, so the dialog can say it.
  async function askDelete(s) {
    try { setConfirmDel({ store: s, impact: await api.get(`/stores/${s.id}/impact`) }); }
    catch (e) { toast(e.message, 'error'); }
  }

  async function remove() {
    const { store } = confirmDel;
    setConfirmDel(null);
    try {
      const r = await api.del(`/stores/${store.id}`);
      toast(r.softDeleted
        ? `${store.name} deactivated — ${r.audits} audit(s) keep their history`
        : `${store.name} deleted`);
      load();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function reactivate(s) {
    try {
      await api.post(`/stores/${s.id}/reactivate`, {});
      toast(`${s.name} reactivated — reassign its auditors on the Users tab`);
      load();
    } catch (e) { toast(e.message, 'error'); }
  }

  if (!stores) return <Spinner />;
  const imp = confirmDel?.impact;
  return (
    <div className="grid md:grid-cols-3 gap-4">
      <div className="card p-4 h-fit">
        <h3 className="font-bold mb-3">Add store</h3>
        <div className="space-y-2">
          <input className="field" placeholder="Code (e.g. AERO)" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
          <input className="field" placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input className="field" placeholder="Address" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
          <label className="block">
            <span className="text-sm font-medium text-slate-600">Type</span>
            <select className="field mt-1" value={f.inventory_mode}
                    onChange={(e) => setF({ ...f, inventory_mode: e.target.value })}>
              <option value="cafe">Cafe — item master, super categories, blind count</option>
              <option value="warehouse">Warehouse — stock by batch, system qty shown</option>
            </select>
          </label>
          {err && <p className="text-red-600 text-sm">{err}</p>}
          <button className="btn-primary w-full" onClick={add}>Add</button>
        </div>
      </div>
      <div className="md:col-span-2">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <ActiveFilter value={active} onChange={setActive} />
          <span className="text-sm text-slate-500">{stores.length} store(s)</span>
        </div>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500"><tr>
              <th className="px-4 py-3">Code</th><th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Address</th><th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Audits</th>
              <th className="px-4 py-3">Active</th><th className="px-4 py-3"></th></tr></thead>
            <tbody className="divide-y">
              {stores.map((s) => (
                <tr key={s.id} className={s.is_active ? '' : 'bg-slate-50/60'}>
                  <td className="px-4 py-2 font-mono">{s.code}</td>
                  <td className="px-4 py-2 font-medium">
                    {s.name}{!s.is_active && <InactiveBadge />}
                  </td>
                  <td className="px-4 py-2 text-slate-500">{s.address}</td>
                  <td className="px-4 py-2">
                    <select className="field py-1 px-2 w-32" value={s.inventory_mode || 'cafe'}
                            onChange={(e) => setMode(s, e.target.value)}>
                      <option value="cafe">Cafe</option>
                      <option value="warehouse">Warehouse</option>
                    </select>
                  </td>
                  <td className="px-4 py-2 text-slate-500">{s.audit_count ?? 0}</td>
                  <td className="px-4 py-2"><button className="text-brand" onClick={() => toggle(s)}>{s.is_active ? 'Active' : 'Inactive'}</button></td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    {s.is_active
                      ? <button className="text-red-600 font-medium" onClick={() => askDelete(s)}>Delete</button>
                      : <button className="text-green-600 font-medium" onClick={() => reactivate(s)}>Reactivate</button>}
                  </td>
                </tr>
              ))}
              {stores.length === 0 && (
                <tr><td colSpan={7} className="p-6 text-center text-slate-400">No stores.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmDialog
        open={!!confirmDel}
        title={`Delete "${confirmDel?.store.name}"?`}
        message={imp
          ? (imp.softDelete
              ? `This store has ${imp.reason}. It will be DEACTIVATED, not deleted, so those audits and their reports stay intact. It disappears from store dropdowns and counting screens. ${imp.user_links} auditor assignment(s) will be removed.`
              : `This store has no audits against it and will be permanently deleted. ${imp.user_links} auditor assignment(s) will be removed.`)
          : ''}
        confirmLabel={imp?.softDelete ? 'Deactivate' : 'Delete'}
        danger
        onCancel={() => setConfirmDel(null)}
        onConfirm={remove}
      />
    </div>
  );
}

function Users() {
  const [users, setUsers] = useState(null);
  const [counts, setCounts] = useState({});
  const [allStores, setAllStores] = useState([]);     // for showing assignments
  const [activeStores, setActiveStores] = useState([]); // for choosing them
  const [f, setF] = useState({ username: '', name: '', password: '', role: 'auditor', store_ids: [] });
  const [err, setErr] = useState('');
  const [active, setActive] = useState('active');
  const [confirmDel, setConfirmDel] = useState(null); // { user, impact }
  const [editing, setEditing] = useState(null);       // { id, name, role, store_ids, password }
  const [editErr, setEditErr] = useState('');
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const { user: me } = useAuth();

  // Edit an existing user — name, role, password reset and, above all, which
  // stores they are assigned to. Assignments are REPLACED by what is chosen
  // here, so moving an auditor to another store is one save.
  function startEdit(u) {
    setEditErr('');
    setEditing({ id: u.id, username: u.username, name: u.name, role: u.role,
                 store_ids: [...(u.store_ids || [])], password: '' });
  }
  function toggleEditStore(id) {
    setEditing((e) => ({ ...e, store_ids: e.store_ids.includes(id)
      ? e.store_ids.filter((x) => x !== id) : [...e.store_ids, id] }));
  }
  async function saveEdit() {
    setEditErr('');
    if (!editing.name.trim()) { setEditErr('Name is required.'); return; }
    if (editing.password && editing.password.length < 8) {
      setEditErr('A new password must be at least 8 characters.'); return;
    }
    setSaving(true);
    try {
      const payload = { name: editing.name.trim(), role: editing.role,
                        store_ids: editing.role === 'auditor' ? editing.store_ids : [] };
      if (editing.password) payload.password = editing.password;
      await api.put(`/users/${editing.id}`, payload);
      toast(`${editing.name.trim()} updated`);
      setEditing(null);
      await load();
    } catch (e) { setEditErr(e.message); } finally { setSaving(false); }
  }

  const load = useCallback(
    () => api.get(`/users?active=${active}`).then((r) => { setUsers(r.users); setCounts(r.counts); }),
    [active]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    // Assignments are shown against every store, including deactivated ones, so
    // a historical mapping still reads correctly — but only ACTIVE stores can
    // be picked for a new assignment.
    api.get('/stores?active=all').then(setAllStores);
    api.get('/stores').then(setActiveStores);
  }, []);

  async function add() {
    setErr('');
    try { await api.post('/users', f); setF({ username: '', name: '', password: '', role: 'auditor', store_ids: [] }); load(); }
    catch (e) { setErr(e.message); }
  }
  function toggleStore(id) {
    setF((p) => ({ ...p, store_ids: p.store_ids.includes(id) ? p.store_ids.filter((x) => x !== id) : [...p.store_ids, id] }));
  }
  async function toggleActive(u) { await api.put(`/users/${u.id}`, { is_active: !u.is_active }); load(); }

  async function askDelete(u) {
    try { setConfirmDel({ user: u, impact: await api.get(`/users/${u.id}/impact`) }); }
    catch (e) { toast(e.message, 'error'); }
  }

  async function remove() {
    const { user } = confirmDel;
    setConfirmDel(null);
    try {
      const r = await api.del(`/users/${user.id}`);
      toast(r.softDeleted
        ? `${user.name} deactivated — ${r.entries} count entries keep their reference`
        : `${user.name} deleted`);
      load();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function reactivate(u) {
    try {
      await api.post(`/users/${u.id}/reactivate`, {});
      toast(`${u.name} reactivated`);
      load();
    } catch (e) { toast(e.message, 'error'); }
  }

  if (!users) return <Spinner />;
  const imp = confirmDel?.impact;
  const storeCode = (id) => allStores.find((s) => s.id === id)?.code;

  return (
    <div className="grid md:grid-cols-3 gap-4">
      <div className="card p-4 h-fit">
        <h3 className="font-bold mb-3">Add user</h3>
        <div className="space-y-2">
          <input className="field" placeholder="Username" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />
          <input className="field" placeholder="Full name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <PasswordField placeholder="Password" value={f.password}
                         onChange={(e) => setF({ ...f, password: e.target.value })} />
          <select className="field" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            <option value="auditor">Auditor</option><option value="admin">Admin</option>
          </select>
          {f.role === 'auditor' && (
            <div>
              <div className="text-sm text-slate-600 mb-1">Assigned stores</div>
              <div className="flex flex-wrap gap-2">
                {/* Deactivated stores are never offered here. */}
                {activeStores.map((s) => (
                  <button key={s.id} className={f.store_ids.includes(s.id) ? 'chip-on' : 'chip-off'} onClick={() => toggleStore(s.id)}>{s.code}</button>
                ))}
                {activeStores.length === 0 && <span className="text-sm text-slate-400">No active stores.</span>}
              </div>
            </div>
          )}
          {err && <p className="text-red-600 text-sm">{err}</p>}
          <button className="btn-primary w-full" onClick={add}>Add user</button>
        </div>
      </div>
      <div className="md:col-span-2">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <ActiveFilter value={active} onChange={setActive} />
          <span className="text-sm text-slate-500">
            {users.length} shown · {counts.active ?? 0} active · {counts.inactive ?? 0} inactive
          </span>
        </div>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500"><tr>
              <th className="px-4 py-3">User</th><th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Stores</th><th className="px-4 py-3">Entries</th>
              <th className="px-4 py-3">Active</th><th className="px-4 py-3"></th></tr></thead>
            <tbody className="divide-y">
              {users.map((u) => (
                <tr key={u.id} className={u.is_active ? '' : 'bg-slate-50/60'}>
                  <td className="px-4 py-2">
                    <div className="font-medium">
                      {u.name}{!u.is_active && <InactiveBadge />}
                    </div>
                    <div className="text-xs text-slate-400">{u.username}</div>
                  </td>
                  <td className="px-4 py-2 capitalize">{u.role}</td>
                  <td className="px-4 py-2 text-slate-500">
                    {u.role === 'admin' ? 'all'
                      : (u.store_ids || []).map(storeCode).filter(Boolean).join(', ') || '—'}
                  </td>
                  <td className="px-4 py-2 text-slate-500">{u.entry_count}</td>
                  <td className="px-4 py-2"><button className="text-brand" onClick={() => toggleActive(u)}>{u.is_active ? 'Active' : 'Inactive'}</button></td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    <button className="text-brand font-medium mr-3" onClick={() => startEdit(u)}>Edit</button>
                    {/* An admin can never delete the account they are signed in with. */}
                    {String(u.id) === String(me?.id)
                      ? <span className="text-slate-400 text-xs">your account</span>
                      : u.is_active
                        ? <button className="text-red-600 font-medium" onClick={() => askDelete(u)}>Delete</button>
                        : <button className="text-green-600 font-medium" onClick={() => reactivate(u)}>Reactivate</button>}
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr><td colSpan={6} className="p-6 text-center text-slate-400">No users.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
             onClick={() => !saving && setEditing(null)}>
          <div className="card w-full max-w-lg p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-bold text-lg">Edit {editing.username}</h2>
            <label className="block">
              <span className="text-sm font-medium text-slate-600">Full name</span>
              <input className="field mt-1" value={editing.name}
                     onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-slate-600">Role</span>
              {/* Your own role cannot be changed here — it would lock you out. */}
              <select className="field mt-1" value={editing.role}
                      disabled={String(editing.id) === String(me?.id)}
                      onChange={(e) => setEditing({ ...editing, role: e.target.value })}>
                <option value="auditor">Auditor</option><option value="admin">Admin</option>
              </select>
            </label>
            {editing.role === 'auditor' && (
              <div>
                <div className="text-sm font-medium text-slate-600 mb-1">Assigned stores</div>
                <div className="flex flex-wrap gap-2">
                  {activeStores.map((st) => (
                    <button key={st.id} className={editing.store_ids.includes(st.id) ? 'chip-on' : 'chip-off'}
                            onClick={() => toggleEditStore(st.id)}>
                      {st.code}{st.inventory_mode === 'warehouse' ? ' · WH' : ''}
                    </button>
                  ))}
                  {/* A deactivated store stays listed while assigned, so it can be removed. */}
                  {allStores.filter((st) => !st.is_active && editing.store_ids.includes(st.id)).map((st) => (
                    <button key={st.id} className="chip-on opacity-60" onClick={() => toggleEditStore(st.id)}>
                      {st.code} (inactive) ✕
                    </button>
                  ))}
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Tap to add or remove. The auditor sees only the stores selected here. Counts already
                  recorded in a store stay where they are.
                </p>
              </div>
            )}
            <label className="block">
              <span className="text-sm font-medium text-slate-600">Reset password (optional)</span>
              <PasswordField placeholder="Leave blank to keep the current password" value={editing.password}
                             onChange={(e) => setEditing({ ...editing, password: e.target.value })} />
              <span className="text-xs text-slate-500">They will be asked to change it at their next login.</span>
            </label>
            {editErr && <p className="text-red-600 text-sm">{editErr}</p>}
            <div className="flex gap-2 justify-end">
              <button className="btn-ghost" disabled={saving} onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn-primary" disabled={saving} onClick={saveEdit}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDel}
        title={`Delete "${confirmDel?.user.name}"?`}
        message={imp
          ? (imp.softDelete
              ? `This user has ${imp.reason}. The account will be DEACTIVATED, not deleted, so those entries keep their reference and still show this name in historical reports. They can no longer sign in and will not appear in dropdowns.`
              : 'This user has no count entries anywhere and will be permanently deleted, along with their store assignments.')
          : ''}
        confirmLabel={imp?.softDelete ? 'Deactivate' : 'Delete'}
        danger
        onCancel={() => setConfirmDel(null)}
        onConfirm={remove}
      />
    </div>
  );
}
