import { describe, it, expect } from 'vitest';
import { chaosConfigSchemaStrict, prepareChaosConfig } from '../src/validation';
import { formatZodIssue } from '../src/validation-format';
import { z } from 'zod';

function parseExpectIssues(input: unknown): ReturnType<typeof formatZodIssue>[] {
  const result = chaosConfigSchemaStrict.safeParse(input);
  if (result.success) return [];
  const issues = (result.error as z.ZodError).issues;
  return issues.map(formatZodIssue);
}

describe('Zod schema: fetchStream rule shapes', () => {
  it('accepts a fetch-stream drop rule with chunkIndex + probability', () => {
    const res = chaosConfigSchemaStrict.safeParse({
      fetchStream: {
        drops: [{ urlPattern: '/api/chat', chunkIndex: 3, probability: 1 }],
      },
    });
    expect(res.success).toBe(true);
  });

  it('accepts a fetch-stream delay rule without chunkIndex (probabilistic)', () => {
    const res = chaosConfigSchemaStrict.safeParse({
      fetchStream: {
        delays: [{ urlPattern: '/api/chat', delayMs: 250, probability: 0.5 }],
      },
    });
    expect(res.success).toBe(true);
  });

  it('accepts a fetch-stream corruption with strategy + probability', () => {
    const res = chaosConfigSchemaStrict.safeParse({
      fetchStream: {
        corruptions: [{ urlPattern: '/api/chat', strategy: 'truncate', probability: 0.1 }],
      },
    });
    expect(res.success).toBe(true);
  });

  it('accepts a fetch-stream close rule with afterChunk', () => {
    const res = chaosConfigSchemaStrict.safeParse({
      fetchStream: {
        closes: [{ urlPattern: '/api/chat', afterChunk: 5, probability: 1 }],
      },
    });
    expect(res.success).toBe(true);
  });

  it('rejects a fetch-stream close rule with both afterMs and afterChunk', () => {
    const issues = parseExpectIssues({
      fetchStream: {
        closes: [{ urlPattern: '/api/chat', afterMs: 1000, afterChunk: 5, probability: 1 }],
      },
    });
    expect(issues.some((i) => i.message.includes('mutually exclusive'))).toBe(true);
  });

  it('rejects fractional chunkIndex (streams are unbounded)', () => {
    const issues = parseExpectIssues({
      fetchStream: {
        drops: [{ urlPattern: '/api/chat', chunkIndex: 0.5, probability: 1 }],
      },
    });
    expect(issues.some((i) => i.message.toLowerCase().includes('whole number'))).toBe(true);
  });

  it('rejects fractional delayMs', () => {
    const issues = parseExpectIssues({
      fetchStream: {
        delays: [{ urlPattern: '/api/chat', delayMs: 250.5, probability: 1 }],
      },
    });
    expect(issues.some((i) => i.message.toLowerCase().includes('whole number'))).toBe(true);
  });

  it('rejects probability > 1', () => {
    const issues = parseExpectIssues({
      fetchStream: {
        drops: [{ urlPattern: '/api/chat', probability: 1.5 }],
      },
    });
    expect(issues.length).toBeGreaterThan(0);
  });

  it('rejects unknown strategy value', () => {
    const issues = parseExpectIssues({
      fetchStream: {
        corruptions: [{ urlPattern: '/api/chat', strategy: 'shuffle', probability: 1 }],
      },
    });
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe('Zod schema: fetch-stream corruption chunkPattern + phase', () => {
  it('accepts a string chunkPattern', () => {
    const res = chaosConfigSchemaStrict.safeParse({
      fetchStream: {
        corruptions: [{ urlPattern: '/api/chat', chunkPattern: '"tool_calls"', strategy: 'malformed-json', probability: 1 }],
      },
    });
    expect(res.success).toBe(true);
  });

  it('accepts a RegExp chunkPattern without g/y flags', () => {
    const res = chaosConfigSchemaStrict.safeParse({
      fetchStream: {
        corruptions: [{ urlPattern: '*', chunkPattern: /"(tool_calls|tool_use)"/, strategy: 'malformed-json', probability: 1 }],
      },
    });
    expect(res.success).toBe(true);
  });

  it('rejects an empty string chunkPattern', () => {
    const issues = parseExpectIssues({
      fetchStream: {
        corruptions: [{ urlPattern: '*', chunkPattern: '', strategy: 'empty', probability: 1 }],
      },
    });
    expect(issues.some((i) => i.message.includes('chunkPattern must not be empty'))).toBe(true);
  });

  it('rejects a chunkPattern RegExp with global or sticky flags', () => {
    for (const re of [/tool/g, /tool/y]) {
      const issues = parseExpectIssues({
        fetchStream: {
          corruptions: [{ urlPattern: '*', chunkPattern: re, strategy: 'empty', probability: 1 }],
        },
      });
      expect(issues.some((i) => i.message.includes('chunkPattern RegExp must not use global'))).toBe(true);
    }
  });

  it('accepts a kebab-case phase tag in the ai namespace', () => {
    const res = chaosConfigSchemaStrict.safeParse({
      fetchStream: {
        corruptions: [{ urlPattern: '*', strategy: 'malformed-json', probability: 1, phase: 'ai:tool-call-failed' }],
      },
    });
    expect(res.success).toBe(true);
  });

  it('rejects a phase tag outside the ai/user namespaces', () => {
    const issues = parseExpectIssues({
      fetchStream: {
        corruptions: [{ urlPattern: '*', strategy: 'malformed-json', probability: 1, phase: 'engine:start' }],
      },
    });
    expect(issues.some((i) => i.message.includes('phase must be a kebab-case lifecycle tag'))).toBe(true);
  });

  it('rejects a non-kebab phase tag', () => {
    const issues = parseExpectIssues({
      fetchStream: {
        corruptions: [{ urlPattern: '*', strategy: 'malformed-json', probability: 1, phase: 'ai:ToolCall' }],
      },
    });
    expect(issues.some((i) => i.message.includes('phase must be a kebab-case lifecycle tag'))).toBe(true);
  });

  it('rejects a phase tag combined with the duplicate strategy', () => {
    const issues = parseExpectIssues({
      fetchStream: {
        corruptions: [{ urlPattern: '*', strategy: 'duplicate', probability: 1, phase: 'ai:my-tag' }],
      },
    });
    expect(issues.some((i) => i.message.includes("phase is not supported with strategy 'duplicate'"))).toBe(true);
  });

  it('accepts the duplicate strategy without a phase tag', () => {
    const res = chaosConfigSchemaStrict.safeParse({
      fetchStream: {
        corruptions: [{ urlPattern: '*', strategy: 'duplicate', probability: 1 }],
      },
    });
    expect(res.success).toBe(true);
  });
});

describe('Zod schema: ai DSL surface', () => {
  it('accepts a minimal ai config with firstChunkDelayMs', () => {
    const res = chaosConfigSchemaStrict.safeParse({
      ai: { firstChunkDelayMs: 500 },
    });
    expect(res.success).toBe(true);
  });

  it('accepts pauseAfterChunk paired with pauseDurationMs', () => {
    const res = chaosConfigSchemaStrict.safeParse({
      ai: { pauseAfterChunk: 4, pauseDurationMs: 2000 },
    });
    expect(res.success).toBe(true);
  });

  it('rejects pauseAfterChunk without pauseDurationMs', () => {
    const issues = parseExpectIssues({
      ai: { pauseAfterChunk: 4 },
    });
    expect(issues.some((i) => i.message.includes('pauseDurationMs is required'))).toBe(true);
  });

  it('rejects pauseDurationMs without pauseAfterChunk', () => {
    const issues = parseExpectIssues({
      ai: { pauseDurationMs: 2000 },
    });
    expect(issues.some((i) => i.message.includes('pauseAfterChunk is required'))).toBe(true);
  });

  it('rejects fractional firstChunkDelayMs', () => {
    const issues = parseExpectIssues({
      ai: { firstChunkDelayMs: 0.35 },
    });
    expect(issues.some((i) => i.message.toLowerCase().includes('whole number'))).toBe(true);
  });

  it('rejects fractional truncateAfterChunk', () => {
    const issues = parseExpectIssues({
      ai: { truncateAfterChunk: 2.5 },
    });
    expect(issues.some((i) => i.message.toLowerCase().includes('whole number'))).toBe(true);
  });

  it('accepts duplicateChunkProbability in 0..1', () => {
    const res = chaosConfigSchemaStrict.safeParse({
      ai: { duplicateChunkProbability: 0.25 },
    });
    expect(res.success).toBe(true);
  });

  it('rejects duplicateChunkProbability > 1', () => {
    const issues = parseExpectIssues({
      ai: { duplicateChunkProbability: 2 },
    });
    expect(issues.length).toBeGreaterThan(0);
  });

  it('accepts every documented transport value', () => {
    for (const t of ['auto', 'fetch-stream', 'sse', 'websocket'] as const) {
      const res = chaosConfigSchemaStrict.safeParse({ ai: { transport: t } });
      expect(res.success).toBe(true);
    }
  });

  it('rejects an unknown transport value', () => {
    const issues = parseExpectIssues({ ai: { transport: 'grpc' } });
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe('Top-level rules: ai is top-level only', () => {
  it('rejects ai nested inside a preset', () => {
    const res = chaosConfigSchemaStrict.safeParse({
      customPresets: {
        slowChat: { ai: { firstChunkDelayMs: 500 } } as unknown as Record<string, unknown>,
      },
    });
    expect(res.success).toBe(false);
  });

  it('rejects ai nested inside a profile slice', () => {
    const res = chaosConfigSchemaStrict.safeParse({
      customProfiles: {
        chat: { ai: { firstChunkDelayMs: 500 } } as unknown as Record<string, unknown>,
      },
    });
    expect(res.success).toBe(false);
  });

  it('rejects ai nested inside profileOverrides', () => {
    const res = chaosConfigSchemaStrict.safeParse({
      profile: 'mobileCheckout',
      profileOverrides: { ai: { firstChunkDelayMs: 500 } } as unknown as Record<string, unknown>,
    });
    expect(res.success).toBe(false);
  });

  it('allows fetchStream rules nested inside a preset', () => {
    const res = chaosConfigSchemaStrict.safeParse({
      customPresets: {
        slowChat: {
          fetchStream: {
            delays: [{ urlPattern: '/api/chat', delayMs: 200, probability: 1 }],
          },
        },
      },
    });
    expect(res.success).toBe(true);
  });
});

describe('prepareChaosConfig integration: fetchStream slices flow through preset expansion', () => {
  it('appends fetchStream rules from presets onto the merged config', () => {
    const merged = prepareChaosConfig({
      customPresets: {
        slowChat: {
          fetchStream: {
            delays: [{ urlPattern: '/api/chat', delayMs: 250, probability: 1 }],
          },
        },
      },
      presets: ['slowChat'],
      fetchStream: {
        drops: [{ urlPattern: '/api/chat', probability: 0.1 }],
      },
    });
    expect(merged.fetchStream?.delays?.length).toBe(1);
    expect(merged.fetchStream?.delays?.[0].delayMs).toBe(250);
    expect(merged.fetchStream?.drops?.length).toBe(1);
  });

  it('compiles the top-level ai surface into transport rule arrays', () => {
    const merged = prepareChaosConfig({
      ai: { firstChunkDelayMs: 800, transport: 'auto' },
    });
    // The compiler strips `ai` and appends compiled rules to the streaming
    // transport buckets so the runtime never sees the AI surface.
    expect(merged.ai).toBeUndefined();
    expect(merged.fetchStream?.delays?.[0]).toMatchObject({
      chunkIndex: 0,
      delayMs: 800,
      probability: 1,
    });
    expect(merged.sse?.delays?.[0]).toMatchObject({ onNth: 1, delayMs: 800 });
    expect(merged.websocket?.delays?.[0]).toMatchObject({
      direction: 'inbound',
      onNth: 1,
      delayMs: 800,
    });
  });
});
