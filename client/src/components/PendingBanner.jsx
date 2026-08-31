import { useEffect, useState } from 'react';
import { pendingCount, onPendingChange, flushQueue, startQueueAutoRetry,
         rejectedEntries, onRejectedChange, clearRejected } from '../lib/queue.js';

// Shows "N entry pending — retrying" while queued entries wait for the network,
// and — louder — any entry the server refused outright.
export default function PendingBanner() {
  const [count, setCount] = useState(pendingCount());
  const [rejects, setRejects] = useState(rejectedEntries());
  useEffect(() => {
    const off = onPendingChange(setCount);
    const offR = onRejectedChange(() => setRejects(rejectedEntries()));
    const stop = startQueueAutoRetry();
    return () => { off(); offR(); stop(); };
  }, []);

  // A refused entry is a count somebody took that never landed. It used to be
  // deleted without a word; now it stays on screen until it is dealt with.
  if (rejects.length > 0) {
    return (
      <div className="fixed bottom-0 inset-x-0 z-40 bg-red-600 text-white text-sm
                      px-4 py-2 shadow-lg">
        <div className="font-semibold">
          {rejects.length} {rejects.length === 1 ? 'entry was' : 'entries were'} not saved —
          count {rejects.length === 1 ? 'it' : 'them'} again
        </div>
        <ul className="mt-0.5 max-h-24 overflow-y-auto">
          {rejects.map((r) => (
            <li key={r.id} className="flex items-center gap-2">
              <span className="truncate">
                qty {r.payload?.qty ?? `${r.payload?.bottles ?? 0} btl`} — {r.error}
              </span>
              <button className="underline shrink-0 ml-auto"
                      onClick={() => clearRejected(r.id)}>Dismiss</button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (count === 0) return null;
  return (
    <div className="fixed bottom-0 inset-x-0 z-40 bg-amber-500 text-white text-sm font-medium
                    px-4 py-2 flex items-center justify-between shadow-lg">
      <span>⏳ {count} {count === 1 ? 'entry' : 'entries'} pending — retrying…</span>
      <button className="underline" onClick={() => flushQueue()}>Retry now</button>
    </div>
  );
}
