// Pure slot engine. All times are minutes from midnight in the BRANCH-LOCAL day
// (the caller converts to/from UTC; DST-safe because one local day is computed at a time).
export type Interval = { start: number; end: number };

export function mergeIntervals(xs: Interval[]): Interval[] {
  const s = xs.filter(i => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of s) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

/** work windows minus busy (breaks, bookings, time-off, blocks, branch closed) */
export function freeIntervals(work: Interval[], busy: Interval[]): Interval[] {
  const b = mergeIntervals(busy);
  const free: Interval[] = [];
  for (const w of mergeIntervals(work)) {
    let cur = w.start;
    for (const x of b) {
      if (x.end <= cur || x.start >= w.end) continue;
      if (x.start > cur) free.push({ start: cur, end: x.start });
      cur = Math.max(cur, x.end);
    }
    if (cur < w.end) free.push({ start: cur, end: w.end });
  }
  return free;
}

export function computeSlots(p: {
  work: Interval[]; busy: Interval[]; duration: number;
  step?: number; earliest?: number; // earliest = "now + min lead time" for today
}): number[] {
  const step = p.step ?? 15, earliest = p.earliest ?? 0, out: number[] = [];
  for (const f of freeIntervals(p.work, p.busy)) {
    for (let s = Math.ceil(Math.max(f.start, earliest) / step) * step; s + p.duration <= f.end; s += step) out.push(s);
  }
  return out;
}
