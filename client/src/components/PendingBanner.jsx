import { useEffect, useState } from 'react';
import { pendingCount, onPendingChange, flushQueue, startQueueAutoRetry } from '../lib/queue.js';

// Shows "N entry pending — retrying" while queued entries wait for the network.
export default function PendingBanner() {
  const [count, setCount] = useState(pendingCount());
  useEffect(() => {
    const off = onPendingChange(setCount);
    const stop = startQueueAutoRetry();
    return () => { off(); stop(); };
  }, []);
  if (count === 0) return null;
  return (
    <div className="fixed bottom-0 inset-x-0 z-40 bg-amber-500 text-white text-sm font-medium
                    px-4 py-2 flex items-center justify-between shadow-lg">
      <span>⏳ {count} {count === 1 ? 'entry' : 'entries'} pending — retrying…</span>
      <button className="underline" onClick={() => flushQueue()}>Retry now</button>
    </div>
  );
}
