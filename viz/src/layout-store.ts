/**
 * Layout persistence: positions keyed by node id (never index — the index
 * space shifts whenever the graph or the tests filter changes), stored per
 * target in localStorage. Everything is best-effort: storage can be absent,
 * full, or blocked, and the viz must render identically without it.
 */

const keyFor = (target: string): string => `gnosis:layout:${target}`;

export function loadLayout(target: string): Map<string, [number, number]> | undefined {
  try {
    const raw = localStorage.getItem(keyFor(target));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { positions?: Record<string, [number, number]> };
    if (!parsed.positions) return undefined;
    return new Map(Object.entries(parsed.positions));
  } catch {
    return undefined;
  }
}

export function saveLayout(target: string, ids: string[], flat: number[] | Float32Array): void {
  try {
    const positions: Record<string, [number, number]> = {};
    for (let i = 0; i < ids.length; i += 1) {
      const x = flat[i * 2];
      const y = flat[i * 2 + 1];
      if (x === undefined || y === undefined || Number.isNaN(x) || Number.isNaN(y)) continue;
      positions[ids[i]!] = [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
    }
    localStorage.setItem(keyFor(target), JSON.stringify({ savedAt: Date.now(), positions }));
  } catch {
    // storage full or unavailable — the layout just won't survive the reload
  }
}

export function clearLayout(target: string): void {
  try {
    localStorage.removeItem(keyFor(target));
  } catch {
    // nothing to clear, or storage blocked — either way the reseed proceeds
  }
}
