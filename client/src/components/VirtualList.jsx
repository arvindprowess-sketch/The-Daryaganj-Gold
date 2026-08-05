import { useEffect, useRef, useState } from 'react';

// ═══════════════════════════════════════════════════════════════════════════
// Window-scrolled virtualised list.
//
// FOOD alone holds ~299 items, and a phone renders 299 rows (each with a photo
// thumbnail) slowly. This mounts only the rows near the viewport, keeping the
// DOM small while the scrollbar still reflects the full list height.
//
// Rows are a fixed height so the maths stays cheap and scroll position is
// exact — no measurement pass, no layout thrash.
// ═══════════════════════════════════════════════════════════════════════════
export default function VirtualList({
  items,
  rowHeight = 84,
  overscan = 6,
  renderRow,
  emptyMessage = 'No items match.',
}) {
  const containerRef = useRef(null);
  const [range, setRange] = useState({ start: 0, end: 30 });

  useEffect(() => {
    function recompute() {
      const el = containerRef.current;
      if (!el) return;
      // Offset of the list within the page, and how far the page is scrolled
      // past it.
      const top = el.getBoundingClientRect().top + window.scrollY;
      const scrolled = Math.max(0, window.scrollY - top);
      const visible = window.innerHeight;
      const start = Math.max(0, Math.floor(scrolled / rowHeight) - overscan);
      const end = Math.min(
        items.length,
        Math.ceil((scrolled + visible) / rowHeight) + overscan
      );
      setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    }
    recompute();
    window.addEventListener('scroll', recompute, { passive: true });
    window.addEventListener('resize', recompute);
    return () => {
      window.removeEventListener('scroll', recompute);
      window.removeEventListener('resize', recompute);
    };
  }, [items.length, rowHeight, overscan]);

  if (items.length === 0) {
    return <div className="p-8 text-center text-slate-400">{emptyMessage}</div>;
  }

  const visible = items.slice(range.start, range.end);

  return (
    <div ref={containerRef} style={{ height: items.length * rowHeight, position: 'relative' }}>
      <div style={{ transform: `translateY(${range.start * rowHeight}px)` }}>
        {visible.map((item, i) => (
          <div key={item.id ?? range.start + i} style={{ height: rowHeight }}>
            {renderRow(item)}
          </div>
        ))}
      </div>
    </div>
  );
}
