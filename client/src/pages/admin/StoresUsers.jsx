import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';
import { Spinner } from '../../components/ui.jsx';

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

function Stores() {
  const [stores, setStores] = useState(null);
  const [f, setF] = useState({ code: '', name: '', address: '' });
  const [err, setErr] = useState('');
  const load = useCallback(() => api.get('/stores').then(setStores), []);
  useEffect(() => { load(); }, [load]);

  async function add() {
    setErr('');
    try { await api.post('/stores', f); setF({ code: '', name: '', address: '' }); load(); }
    catch (e) { setErr(e.message); }
  }
  async function toggle(s) { await api.put(`/stores/${s.id}`, { is_active: !s.is_active }); load(); }

  if (!stores) return <Spinner />;
  return (
    <div className="grid md:grid-cols-3 gap-4">
      <div className="card p-4 h-fit">
        <h3 className="font-bold mb-3">Add store</h3>
        <div className="space-y-2">
          <input className="field" placeholder="Code (e.g. AERO)" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
          <input className="field" placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input className="field" placeholder="Address" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
          {err && <p className="text-red-600 text-sm">{err}</p>}
          <button className="btn-primary w-full" onClick={add}>Add</button>
        </div>
      </div>
      <div className="card md:col-span-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500"><tr>
            <th className="px-4 py-3">Code</th><th className="px-4 py-3">Name</th>
            <th className="px-4 py-3">Address</th><th className="px-4 py-3">Active</th></tr></thead>
          <tbody className="divide-y">
            {stores.map((s) => (
              <tr key={s.id}>
                <td className="px-4 py-2 font-mono">{s.code}</td>
                <td className="px-4 py-2 font-medium">{s.name}</td>
                <td className="px-4 py-2 text-slate-500">{s.address}</td>
                <td className="px-4 py-2"><button className="text-brand" onClick={() => toggle(s)}>{s.is_active ? 'Active' : 'Inactive'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Users() {
  const [users, setUsers] = useState(null);
  const [stores, setStores] = useState([]);
  const [f, setF] = useState({ username: '', name: '', password: '', role: 'auditor', store_ids: [] });
  const [err, setErr] = useState('');
  const load = useCallback(() => api.get('/users').then(setUsers), []);
  useEffect(() => { load(); api.get('/stores').then(setStores); }, [load]);

  async function add() {
    setErr('');
    try { await api.post('/users', f); setF({ username: '', name: '', password: '', role: 'auditor', store_ids: [] }); load(); }
    catch (e) { setErr(e.message); }
  }
  function toggleStore(id) {
    setF((p) => ({ ...p, store_ids: p.store_ids.includes(id) ? p.store_ids.filter((x) => x !== id) : [...p.store_ids, id] }));
  }
  async function toggleActive(u) { await api.put(`/users/${u.id}`, { is_active: !u.is_active }); load(); }

  if (!users) return <Spinner />;
  return (
    <div className="grid md:grid-cols-3 gap-4">
      <div className="card p-4 h-fit">
        <h3 className="font-bold mb-3">Add user</h3>
        <div className="space-y-2">
          <input className="field" placeholder="Username" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />
          <input className="field" placeholder="Full name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input className="field" type="password" placeholder="Password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          <select className="field" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            <option value="auditor">Auditor</option><option value="admin">Admin</option>
          </select>
          {f.role === 'auditor' && (
            <div>
              <div className="text-sm text-slate-600 mb-1">Assigned stores</div>
              <div className="flex flex-wrap gap-2">
                {stores.map((s) => (
                  <button key={s.id} className={f.store_ids.includes(s.id) ? 'chip-on' : 'chip-off'} onClick={() => toggleStore(s.id)}>{s.code}</button>
                ))}
              </div>
            </div>
          )}
          {err && <p className="text-red-600 text-sm">{err}</p>}
          <button className="btn-primary w-full" onClick={add}>Add user</button>
        </div>
      </div>
      <div className="card md:col-span-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500"><tr>
            <th className="px-4 py-3">User</th><th className="px-4 py-3">Role</th>
            <th className="px-4 py-3">Stores</th><th className="px-4 py-3">Active</th></tr></thead>
          <tbody className="divide-y">
            {users.map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-2"><div className="font-medium">{u.name}</div><div className="text-xs text-slate-400">{u.username}</div></td>
                <td className="px-4 py-2 capitalize">{u.role}</td>
                <td className="px-4 py-2 text-slate-500">
                  {u.role === 'admin' ? 'all' : (u.store_ids || []).map((id) => stores.find((s) => s.id === id)?.code).filter(Boolean).join(', ') || '—'}
                </td>
                <td className="px-4 py-2"><button className="text-brand" onClick={() => toggleActive(u)}>{u.is_active ? 'Active' : 'Inactive'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
