import { describe, it, expect } from 'vitest';
import { compileAiToRules } from '../src/ai';
import { prepareChaosConfig } from '../src/validation';
import { ChaosConfigError } from '../src/errors';
import type { ChaosConfig, ReplayFixture } from '../src/config';

function fx(overrides: Partial<ReplayFixture> = {}): ReplayFixture {
  return {
    version: 1,
    transport: 'fetch-stream',
    url: 'https://api.example.com/chat',
    chunks: [{ offsetMs: 0, data: 'a' }],
    ...overrides,
  };
}

describe('ai.replay compiler', () => {
  it('compiles to a replay directive on every streaming transport under auto', () => {
    const cfg: ChaosConfig = { ai: { replay: { data: fx() } } };
    compileAiToRules(cfg);
    expect(cfg.ai).toBeUndefined();
    expect(cfg.fetchStream?.replay?.data.chunks).toHaveLength(1);
    expect(cfg.sse?.replay).toBeDefined();
    expect(cfg.websocket?.replay).toBeDefined();
    // urlPattern defaults to the fixture url when none is given
    expect(cfg.fetchStream?.replay?.urlPattern).toBe('https://api.example.com/chat');
  });

  it('scopes to a single transport', () => {
    const cfg: ChaosConfig = { ai: { transport: 'fetch-stream', replay: { data: fx() } } };
    compileAiToRules(cfg);
    expect(cfg.fetchStream?.replay).toBeDefined();
    expect(cfg.sse).toBeUndefined();
    expect(cfg.websocket).toBeUndefined();
  });

  it('honors explicit urlPattern, mutations, and blockUpstream', () => {
    const cfg: ChaosConfig = {
      ai: {
        transport: 'fetch-stream',
        replay: { data: fx(), urlPattern: '/chat', blockUpstream: false, mutations: [{ type: 'truncate', afterChunk: 0 }] },
      },
    };
    compileAiToRules(cfg);
    const replay = cfg.fetchStream!.replay!;
    expect(replay.urlPattern).toBe('/chat');
    expect(replay.blockUpstream).toBe(false);
    expect(replay.mutations).toHaveLength(1);
  });
});

describe('ai.replay validation via prepareChaosConfig', () => {
  it('accepts a valid inline fixture and strips the ai slice', () => {
    const out = prepareChaosConfig({ ai: { transport: 'fetch-stream', replay: { data: fx() } } });
    expect(out.fetchStream?.replay?.data.version).toBe(1);
    expect(out.ai).toBeUndefined();
  });

  it('rejects an unsupported fixture version', () => {
    expect(() =>
      prepareChaosConfig({ ai: { replay: { data: { version: 2, transport: 'fetch-stream', chunks: [] } } } }),
    ).toThrow(ChaosConfigError);
  });

  it('rejects an unresolved fixture path with no inline data', () => {
    expect(() => prepareChaosConfig({ ai: { replay: { fixture: 'fixtures/chat.json' } } })).toThrow(ChaosConfigError);
  });

  it('rejects a direct fetchStream.replay fixture with a bad version', () => {
    expect(() =>
      prepareChaosConfig({
        fetchStream: { replay: { urlPattern: '/chat', data: { version: 9, transport: 'fetch-stream', chunks: [] } } },
      }),
    ).toThrow(ChaosConfigError);
  });
});
