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

/**
 * Create a seedable random number generator.
 * If no seed is provided, one is auto-generated.
 *
 * @returns An object with the `random` function and the `seed` used.
 */
export function createPrng(seed?: number): { random: () => number; seed: number } {
  const resolvedSeed = seed ?? generateSeed();
  return {
    random: mulberry32(resolvedSeed),
    seed: resolvedSeed,
  };
}
