import { describe, it, expect } from 'vitest';
import { chaosConfigSchemaStrict, prepareChaosConfig, validateChaosConfig } from '../src/validation';
import { formatZodIssue } from '../src/validation-format';
import { stripUnknownKeys, collectUnknownPaths } from '../src/validation-strip';
import type { ChaosConfig, UserInteractionConfig } from '../src/config';
import type { ValidationIssue } from '../src/validation-types';
import { z } from 'zod';

function parseExpectIssues(input: unknown): ReturnType<typeof formatZodIssue>[] {
  const result = chaosConfigSchemaStrict.safeParse(input);
  if (result.success) return [];
  const issues = (result.error as z.ZodError).issues;
  return issues.map(formatZodIssue);
}

const FULL_SURFACE: UserInteractionConfig = {
  cancelStreamAfterMs: 4000,
  retryStorm: { count: 5, intervalMs: 200, afterMs: 100, selector: '#retry' },
  tabHidden: { afterMs: 1000, durationMs: 3000 },
  blurWindow: { afterMs: 2000, durationMs: 500 },
  promptEditDuringResponse: { afterMs: 1500, simulateTypingMs: 800, selector: '#prompt', text: 'edited' },
  navigateAway: { afterMs: 6000, target: '/' },
};

describe('Zod schema: userInteraction trigger shapes', () => {
  it('accepts the full trigger surface', () => {
    const res = chaosConfigSchemaStrict.safeParse({ userInteraction: FULL_SURFACE });
    expect(res.success).toBe(true);
  });

  it('accepts an empty userInteraction object', () => {
    const res = chaosConfigSchemaStrict.safeParse({ userInteraction: {} });
    expect(res.success).toBe(true);
  });

  it('accepts afterMs 0 (immediate trigger)', () => {
    const res = chaosConfigSchemaStrict.safeParse({
      userInteraction: { tabHidden: { afterMs: 0, durationMs: 100 } },
    });
    expect(res.success).toBe(true);
  });

  it('rejects fractional cancelStreamAfterMs', () => {
    const issues = parseExpectIssues({ userInteraction: { cancelStreamAfterMs: 100.5 } });
    expect(issues.some((i) => i.message.includes('whole number'))).toBe(true);
    expect(issues[0]?.ruleType).toBe('user-interaction');
  });

  it('rejects negative durations', () => {
    const issues = parseExpectIssues({
      userInteraction: { blurWindow: { afterMs: -1, durationMs: 500 } },
    });
    expect(issues.some((i) => i.code === 'value_too_small')).toBe(true);
  });

  it('rejects retryStorm count 0 and fractional count', () => {
    expect(
      parseExpectIssues({ userInteraction: { retryStorm: { count: 0, intervalMs: 100 } } })
        .some((i) => i.message.includes('count must be >= 1')),
    ).toBe(true);
    expect(
      parseExpectIssues({ userInteraction: { retryStorm: { count: 1.5, intervalMs: 100 } } })
        .some((i) => i.message.includes('count must be a whole number')),
    ).toBe(true);
  });

  it('rejects a missing required field on a trigger', () => {
    const issues = parseExpectIssues({ userInteraction: { tabHidden: { afterMs: 1000 } } });
    expect(issues.some((i) => i.code === 'missing_field' && i.path === 'userInteraction.tabHidden.durationMs')).toBe(true);
  });

  it('rejects empty selector, target, and text strings', () => {
    expect(
      parseExpectIssues({ userInteraction: { retryStorm: { count: 1, intervalMs: 100, selector: '' } } }).length,
    ).toBeGreaterThan(0);
    expect(
      parseExpectIssues({ userInteraction: { navigateAway: { afterMs: 100, target: '' } } }).length,
    ).toBeGreaterThan(0);
    expect(
      parseExpectIssues({
        userInteraction: { promptEditDuringResponse: { afterMs: 100, simulateTypingMs: 100, text: '' } },
      }).length,
    ).toBeGreaterThan(0);
  });

  it('rejects unknown keys at both levels under strict policy', () => {
    expect(
      parseExpectIssues({ userInteraction: { bogus: 1 } }).some((i) => i.code === 'unknown_field'),
    ).toBe(true);
    expect(
      parseExpectIssues({
        userInteraction: { retryStorm: { count: 1, intervalMs: 100, bogus: 1 } },
      }).some((i) => i.code === 'unknown_field'),
    ).toBe(true);
  });
});

describe('config strip: userInteraction preservation', () => {
  it('preserves the full known surface and drops unknown keys', () => {
    const stripped = stripUnknownKeys({
      userInteraction: {
        ...FULL_SURFACE,
        bogus: 1,
        retryStorm: { ...FULL_SURFACE.retryStorm, alsoBogus: 2 },
      },
    });
    expect(stripped.userInteraction).toEqual(FULL_SURFACE);
  });

  it('collects unknown paths at both levels', () => {
    const paths = collectUnknownPaths({
      userInteraction: {
        bogus: 1,
        tabHidden: { afterMs: 1, durationMs: 2, extra: 3 },
      },
    });
    expect(paths).toContain('userInteraction.bogus');
    expect(paths).toContain('userInteraction.tabHidden.extra');
  });

  it('survives prepareChaosConfig under unknownFields: ignore', () => {
    const prepared = prepareChaosConfig(
      { userInteraction: { ...FULL_SURFACE, bogus: 1 } },
      { unknownFields: 'ignore' },
    );
    expect(prepared.userInteraction).toEqual(FULL_SURFACE);
  });
});

describe('preset and profile slices carrying userInteraction', () => {
  it('merges per trigger with the user config winning', () => {
    const prepared = prepareChaosConfig({
      presets: ['withInteraction'],
      customPresets: {
        withInteraction: {
          userInteraction: {
            cancelStreamAfterMs: 9999,
            tabHidden: { afterMs: 1, durationMs: 2 },
          },
        },
      },
      userInteraction: { cancelStreamAfterMs: 4000 },
    });
    // User-set trigger wins; preset-only trigger survives.
    expect(prepared.userInteraction?.cancelStreamAfterMs).toBe(4000);
    expect(prepared.userInteraction?.tabHidden).toEqual({ afterMs: 1, durationMs: 2 });
  });

  it('later presets win earlier presets per trigger', () => {
    const prepared = prepareChaosConfig({
      presets: ['first', 'second'],
      customPresets: {
        first: { userInteraction: { cancelStreamAfterMs: 1000, blurWindow: { afterMs: 1, durationMs: 2 } } },
        second: { userInteraction: { cancelStreamAfterMs: 2000 } },
      },
    });
    expect(prepared.userInteraction?.cancelStreamAfterMs).toBe(2000);
    expect(prepared.userInteraction?.blurWindow).toEqual({ afterMs: 1, durationMs: 2 });
  });

  it('profile overrides win the profile and the top-level config per trigger', () => {
    const prepared = prepareChaosConfig({
      profile: 'scenario',
      customProfiles: {
        scenario: { userInteraction: { cancelStreamAfterMs: 1000, tabHidden: { afterMs: 1, durationMs: 2 } } },
      },
      userInteraction: { cancelStreamAfterMs: 2000 },
      profileOverrides: { userInteraction: { cancelStreamAfterMs: 3000 } },
    });
    expect(prepared.userInteraction?.cancelStreamAfterMs).toBe(3000);
    expect(prepared.userInteraction?.tabHidden).toEqual({ afterMs: 1, durationMs: 2 });
  });
});

describe('customValidators: user-interaction hook', () => {
  it('fires with the userInteraction slice and its path', () => {
    const seen: Array<{ rule: unknown; path: string }> = [];
    validateChaosConfig(
      { userInteraction: { cancelStreamAfterMs: 4000 } } satisfies ChaosConfig,
      {
        customValidators: {
          'user-interaction': (rule, ctx) => {
            seen.push({ rule, path: ctx.path });
          },
        },
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe('userInteraction');
    expect((seen[0].rule as UserInteractionConfig).cancelStreamAfterMs).toBe(4000);
  });

  it('surfaces issues returned by the hook', () => {
    const issue: ValidationIssue = {
      path: 'userInteraction',
      code: 'custom',
      ruleType: 'user-interaction',
      message: 'blocked by policy',
    };
    expect(() =>
      validateChaosConfig(
        { userInteraction: { cancelStreamAfterMs: 4000 } },
        { customValidators: { 'user-interaction': () => [issue] } },
      ),
    ).toThrowError(/blocked by policy/);
  });
});
