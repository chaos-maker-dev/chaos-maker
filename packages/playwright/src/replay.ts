import { readFileSync, writeFileSync } from 'node:fs';
import { parseFixture, type ReplayFixture } from '@chaos-maker/core';

/**
 * Load and validate a stream replay fixture from disk (Node side), returning
 * the inline fixture object to embed as `ai.replay.data`. The in-page core
 * cannot read files, so a fixture PATH must be resolved here before the config
 * crosses the page boundary. Throws `ChaosConfigError` on an invalid or
 * unversioned fixture.
 */
export function loadStreamFixture(path: string): ReplayFixture {
  return parseFixture(JSON.parse(readFileSync(path, 'utf8')));
}

export interface RecordStreamFixtureOptions {
  /** Transport label written into the fixture. Default `'fetch-stream'`. */
  transport?: ReplayFixture['transport'];
  /** When set, the fixture JSON is written to this path (pretty-printed). */
  outFile?: string;
}

/**
 * Record a live stream once into a version 1 replay fixture. Runs entirely in
 * Node: fetches the URL, reads the response body to completion, timestamps
 * each chunk relative to the first read, and returns (optionally writing) the
 * fixture. A developer utility for capturing fixtures to commit; not used at
 * test time.
 */
export async function recordStreamFixture(
  url: string,
  options: RecordStreamFixtureOptions = {},
): Promise<ReplayFixture> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`[chaos-maker] cannot record stream fixture: ${url} responded ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const start = Date.now();
  const chunks: ReplayFixture['chunks'] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push({ offsetMs: Date.now() - start, data: decoder.decode(value, { stream: true }) });
  }
  const fixture: ReplayFixture = {
    version: 1,
    transport: options.transport ?? 'fetch-stream',
    url,
    capturedAt: new Date(start).toISOString(),
    chunks,
  };
  if (options.outFile) {
    writeFileSync(options.outFile, `${JSON.stringify(fixture, null, 2)}\n`);
  }
  return fixture;
}
