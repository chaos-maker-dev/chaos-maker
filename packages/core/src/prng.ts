/**
 * Mulberry32  -  a fast, seedable 32-bit PRNG.
 * Returns values in [0, 1) like Math.random().
 *
 * @see https://gist.github.com/tommyettinger/46a874533244883189143505d203312c
 */
function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate a random seed using Math.random().
 * Returns a 32-bit integer.
 */
export function generateSeed(): number {
  return (Math.random() * 4294967296) >>> 0;
}

/** FNV-1a 32-bit string hash used to derive a stable channel offset from a
 *  string label (e.g. `'ai:firstChunk'`). Deterministic across runtimes. */
function hashChannelName(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** PRNG handle. `random` is the primary stream; `subChannel(name)` derives
 *  an independent stream seeded from `seed XOR hashChannelName(name)` so
 *  chaos decisions for one namespace (e.g. the AI compiler) do not perturb
 *  the per-rule decision sequence on other namespaces. */
export interface ChaosPrng {
  random: () => number;
  seed: number;
  /** Derived PRNG for a named channel. Subsequent calls with the same label
   *  return a fresh generator at the same starting state, so callers can
   *  treat each channel as its own deterministic stream from a single seed. */
  subChannel: (name: string) => () => number;
}

/**
 * Create a seedable random number generator.
 * If no seed is provided, one is auto-generated.
 *
 * @returns A `ChaosPrng` with the primary `random` stream, the resolved
 *   `seed`, and a `subChannel(name)` factory for namespaced derived streams.
 */
export function createPrng(seed?: number): ChaosPrng {
  const resolvedSeed = seed ?? generateSeed();
  return {
    random: mulberry32(resolvedSeed),
    seed: resolvedSeed,
    subChannel(name: string): () => number {
      return mulberry32((resolvedSeed ^ hashChannelName(name)) >>> 0);
    },
  };
}
