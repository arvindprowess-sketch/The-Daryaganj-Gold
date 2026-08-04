import { useEffect } from 'react';

// A bottom sheet used for item entry (M6). Slides up from the bottom on mobile;
// on desktop it centers as a modal card.
export default function BottomSheet({ open, onClose, title, children }) {
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full sm:max-w-lg bg-white rounded-t-3xl sm:rounded-3xl
                      max-h-[92vh] overflow-y-auto shadow-2xl animate-[slideup_.2s_ease]">
        <div className="sticky top-0 bg-white/95 backdrop-blur px-4 py-3 border-b flex items-center justify-between">
          <h2 className="font-bold text-lg truncate">{title}</h2>
          <button onClick={onClose} className="text-slate-400 text-2xl leading-none px-2" aria-label="Close">×</button>
        </div>
        <div className="p-4 pb-8">{children}</div>
      </div>
      <style>{`@keyframes slideup{from{transform:translateY(100%)}to{transform:translateY(0)}}`}</style>
    </div>
  );
}
