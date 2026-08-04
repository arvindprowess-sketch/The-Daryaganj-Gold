// Generic confirm dialog. Used for logout (which can lose unsaved entry data)
// and for destructive admin actions like replacing system stock.
export default function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm',
                                        cancelLabel = 'Cancel', danger, onConfirm, onCancel }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-5 bg-black/50" onClick={onCancel}>
      <div className="card p-5 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
        {title && <h3 className="font-bold text-lg mb-1">{title}</h3>}
        <p className="text-slate-600 mb-4">{message}</p>
        <div className="flex gap-2">
          <button className="btn-ghost flex-1" onClick={onCancel}>{cancelLabel}</button>
          <button className={`${danger ? 'btn-danger' : 'btn-primary'} flex-1`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
