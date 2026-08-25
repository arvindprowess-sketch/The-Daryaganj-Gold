// ═══════════════════════════════════════════════════════════════════════════
// Liquor is counted as sealed bottles AND loose millilitres, and the two are
// never combined (design rule: bottles and open ml stay separate everywhere).
//
// A list badge that shows only the bottle count hides the loose stock until
// the item is opened — "3 btl" for an item that actually holds 3 bottles plus
// 630 ml. Both figures belong on the badge:
//
//   3 bottles, 630 ml  ->  "3 btl · 630 ml"
//   3 bottles, 0 ml    ->  "3 btl"
//   0 bottles, 630 ml  ->  "630 ml"
//   nothing            ->  "0 btl"
//
// Kept short deliberately: it has to fit on one line beside the item name on a
// 380px phone without wrapping.
// ═══════════════════════════════════════════════════════════════════════════
export function liquorBadge(bottles, openMl) {
  const b = Number(bottles ?? 0) || 0;
  const ml = Number(openMl ?? 0) || 0;
  if (b > 0 && ml > 0) return `${b} btl · ${ml} ml`;
  if (b > 0) return `${b} btl`;
  if (ml > 0) return `${ml} ml`;
  return '0 btl';
}
