import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import MobileHeader from '../../components/MobileHeader.jsx';
import { Spinner, Empty } from '../../components/ui.jsx';

// M2 — Store selection: only assigned stores; skip if only one.
export default function StoreSelect() {
  const nav = useNavigate();
  const [stores, setStores] = useState(null);

  useEffect(() => {
    api.get('/stores').then((s) => {
      if (s.length === 1) nav(`/a/store/${s[0].id}`, { replace: true });
      else setStores(s);
    });
  }, [nav]);

  if (!stores) return <Spinner label="Loading stores…" />;

  return (
    <div className="min-h-full">
      <MobileHeader title="Select store" />
      <div className="p-4 space-y-3">
        {stores.length === 0 && <Empty>No stores assigned to you.</Empty>}
        {stores.map((s) => (
          <button key={s.id} onClick={() => nav(`/a/store/${s.id}`)}
                  className="card w-full text-left p-4 flex items-center justify-between active:scale-[0.99]">
            <div>
              <div className="font-bold text-lg">
                {s.name}
                {s.inventory_mode === 'warehouse' && (
                  <span className="ml-2 align-middle rounded bg-teal-100 px-1.5 py-0.5 text-[11px] font-semibold text-teal-800">
                    WAREHOUSE
                  </span>
                )}
              </div>
              <div className="text-sm text-slate-500">{s.address || s.code}</div>
            </div>
            <span className="text-brand text-2xl">›</span>
          </button>
        ))}
      </div>
    </div>
  );
}
