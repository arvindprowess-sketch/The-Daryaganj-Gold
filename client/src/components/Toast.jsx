import { createContext, useCallback, useContext, useState } from 'react';

const ToastCtx = createContext(() => {});

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const show = useCallback((message, kind = 'success', ms = 2600) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
  }, []);

  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div className="fixed left-1/2 -translate-x-1/2 bottom-20 z-[70] flex flex-col items-center gap-2 px-4 w-full max-w-sm pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id}
               className={`w-full rounded-xl px-4 py-3 text-sm font-medium shadow-lg text-white
                           ${t.kind === 'error' ? 'bg-red-600' : t.kind === 'warn' ? 'bg-amber-600' : 'bg-slate-900'}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
