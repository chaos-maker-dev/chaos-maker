import { describe, it, expect } from 'vitest';
import { validateConfig } from '../src/validation';
import { ChaosConfigError } from '../src/errors';

describe('validateConfig', () => {
  it('should accept a valid full config', () => {
    const config = {
      network: {
        failures: [
          { urlPattern: '/api', statusCode: 503, probability: 1.0 },
        ],
        latencies: [
          { urlPattern: '/api', delayMs: 1000, probability: 0.5 },
        ],
      },
      ui: {
        assaults: [
          { selector: '#btn', action: 'disable' as const, probability: 0.8 },
        ],
      },
    };
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('should accept an empty config', () => {
    expect(() => validateConfig({})).not.toThrow();
  });

  it('should accept config with empty arrays', () => {
    const config = {
      network: { failures: [], latencies: [] },
      ui: { assaults: [] },
    };
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('should accept probability of exactly 0', () => {
    const config = {
      network: {
        failures: [{ urlPattern: '/api', statusCode: 500, probability: 0 }],
      },
    };
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('should accept probability of exactly 1', () => {
    const config = {
      network: {
        failures: [{ urlPattern: '/api', statusCode: 500, probability: 1 }],
      },
    };
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('should accept custom body, statusText, and headers', () => {
    const config = {
      network: {
        failures: [{
          urlPattern: '/api',
          statusCode: 500,
          probability: 1.0,
          body: '{"error": "custom"}',
          statusText: 'Internal Server Error',
          headers: { 'Content-Type': 'application/json' },
        }],
      },
    };
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('should reject probability > 1', () => {
    const config = {
      network: {
        failures: [{ urlPattern: '/api', statusCode: 500, probability: 1.5 }],
      },
    };
    expect(() => validateConfig(config)).toThrow(ChaosConfigError);
  });

  it('should reject probability < 0', () => {
    const config = {
      network: {
        failures: [{ urlPattern: '/api', statusCode: 500, probability: -0.1 }],
      },
    };
    expect(() => validateConfig(config)).toThrow(ChaosConfigError);
  });

  it('should reject empty urlPattern', () => {
    const config = {
      network: {
        failures: [{ urlPattern: '', statusCode: 500, probability: 1.0 }],
      },
    };
    expect(() => validateConfig(config)).toThrow(ChaosConfigError);
  });

  it('should reject invalid statusCode', () => {
    const config = {
      network: {
        failures: [{ urlPattern: '/api', statusCode: 999, probability: 1.0 }],
      },
    };
    expect(() => validateConfig(config)).toThrow(ChaosConfigError);
  });

  it('should reject negative delayMs', () => {
    const config = {
      network: {
        latencies: [{ urlPattern: '/api', delayMs: -100, probability: 1.0 }],
      },
    };
    expect(() => validateConfig(config)).toThrow(ChaosConfigError);
  });

  it('should reject empty selector', () => {
    const config = {
      ui: {
        assaults: [{ selector: '', action: 'disable', probability: 1.0 }],
      },
    };
    expect(() => validateConfig(config)).toThrow(ChaosConfigError);
  });

  it('should reject invalid action', () => {
    const config = {
      ui: {
        assaults: [{ selector: '#btn', action: 'destroy', probability: 1.0 }],
      },
    };
    expect(() => validateConfig(config)).toThrow(ChaosConfigError);
  });

  it('should include readable issue messages', () => {
    const config = {
      network: {
        failures: [{ urlPattern: '', statusCode: 999, probability: 2.0 }],
      },
    };

    let capturedError: ChaosConfigError | undefined;

    try {
      validateConfig(config);
    } catch (e) {
      capturedError = e as ChaosConfigError;
    }

    expect(capturedError).toBeDefined();
    expect(capturedError).toBeInstanceOf(ChaosConfigError);
    expect(capturedError!.issues.length).toBeGreaterThan(0);
    expect(capturedError!.message).toContain('Invalid ChaosConfig');
  });

  it('should reject missing required fields', () => {
    const config = {
      network: {
        failures: [{ urlPattern: '/api' }],
      },
    };
    expect(() => validateConfig(config)).toThrow(ChaosConfigError);
  });

  it('should reject unknown keys (typos)', () => {
    const config = {
      network: {
        failures: [{ urlPattern: '/api', statusCode: 500, probability: 1.0, delaayMs: 100 }],
      },
    };
    expect(() => validateConfig(config)).toThrow(ChaosConfigError);
  });

  it('should reject unknown top-level keys', () => {
    const config = { networking: { failures: [] } };
    expect(() => validateConfig(config)).toThrow(ChaosConfigError);
  });

  it('should accept a valid integer seed', () => {
    const config = { seed: 42 };
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('should accept seed of 0', () => {
    const config = { seed: 0 };
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('should reject a non-integer seed', () => {
    const config = { seed: 3.14 };
    expect(() => validateConfig(config)).toThrow(ChaosConfigError);
  });

  it('should accept config with seed and network rules', () => {
    const config = {
      seed: 12345,
      network: {
        failures: [{ urlPattern: '/api', statusCode: 500, probability: 1.0 }],
      },
    };
    expect(() => validateConfig(config)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Counting fields (onNth / everyNth / afterN)
  // -------------------------------------------------------------------------
  describe('counting fields', () => {
    it('accepts a single onNth', () => {
      const config = {
        network: {
          failures: [{ urlPattern: '/api', statusCode: 500, probability: 1, onNth: 3 }],
        },
      };
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('accepts a single everyNth', () => {
      const config = {
        network: {
          latencies: [{ urlPattern: '/api', delayMs: 100, probability: 1, everyNth: 2 }],
        },
      };
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('accepts afterN of 0', () => {
      const config = {
        network: {
          failures: [{ urlPattern: '/api', statusCode: 500, probability: 1, afterN: 0 }],
        },
      };
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('rejects onNth of 0', () => {
      const config = {
        network: {
          failures: [{ urlPattern: '/api', statusCode: 500, probability: 1, onNth: 0 }],
        },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });

    it('rejects everyNth of 0', () => {
      const config = {
        network: {
          failures: [{ urlPattern: '/api', statusCode: 500, probability: 1, everyNth: 0 }],
        },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });

    it('rejects negative afterN', () => {
      const config = {
        network: {
          failures: [{ urlPattern: '/api', statusCode: 500, probability: 1, afterN: -1 }],
        },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });

    it('rejects non-integer onNth', () => {
      const config = {
        network: {
          failures: [{ urlPattern: '/api', statusCode: 500, probability: 1, onNth: 1.5 }],
        },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });

    it('rejects combining onNth with everyNth', () => {
      const config = {
        network: {
          failures: [{ urlPattern: '/api', statusCode: 500, probability: 1, onNth: 2, everyNth: 3 }],
        },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });

    it('rejects combining all three counting fields', () => {
      const config = {
        network: {
          failures: [{
            urlPattern: '/api', statusCode: 500, probability: 1,
            onNth: 1, everyNth: 2, afterN: 3,
          }],
        },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });

    it('accepts counting on all network chaos types', () => {
      const config = {
        network: {
          failures: [{ urlPattern: '/api', statusCode: 500, probability: 1, onNth: 2 }],
          latencies: [{ urlPattern: '/api', delayMs: 50, probability: 1, everyNth: 2 }],
          aborts: [{ urlPattern: '/api', probability: 1, afterN: 1 }],
          corruptions: [{ urlPattern: '/api', strategy: 'empty' as const, probability: 1, onNth: 1 }],
          cors: [{ urlPattern: '/api', probability: 1, everyNth: 4 }],
        },
      };
      expect(() => validateConfig(config)).not.toThrow();
    });
  });

  describe('websocket config', () => {
    it('accepts valid drop/delay/corrupt/close rules', () => {
      const config = {
        websocket: {
          drops: [{ urlPattern: '/ws', direction: 'inbound' as const, probability: 0.5 }],
          delays: [{ urlPattern: '/ws', direction: 'outbound' as const, delayMs: 100, probability: 1 }],
          corruptions: [{ urlPattern: '/ws', direction: 'both' as const, strategy: 'truncate' as const, probability: 0.2 }],
          closes: [{ urlPattern: '/ws', code: 4000, reason: 'chaos', afterMs: 500, probability: 1 }],
        },
      };
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('rejects invalid direction', () => {
      const config = {
        websocket: {
          drops: [{ urlPattern: '/ws', direction: 'sideways' as unknown as 'inbound', probability: 1 }],
        },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });

    it('rejects empty urlPattern', () => {
      const config = {
        websocket: {
          drops: [{ urlPattern: '', direction: 'both' as const, probability: 1 }],
        },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });

    it('rejects negative afterMs on close', () => {
      const config = {
        websocket: {
          closes: [{ urlPattern: '/ws', probability: 1, afterMs: -5 }],
        },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });

    it('rejects multiple counting fields on a single ws rule', () => {
      const config = {
        websocket: {
          drops: [{ urlPattern: '/ws', direction: 'both' as const, probability: 1, onNth: 1, everyNth: 2 }],
        },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });

    it('accepts close code 1000', () => {
      const config = {
        websocket: { closes: [{ urlPattern: '/ws', probability: 1, code: 1000 }] },
      };
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('accepts close code in 3000-4999 range', () => {
      const config = {
        websocket: { closes: [{ urlPattern: '/ws', probability: 1, code: 4999 }] },
      };
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('rejects reserved close code 1006', () => {
      // 1006 (Abnormal Closure) is reserved for the browser/protocol and is
      // not a valid input to WebSocket.close(code).
      const config = {
        websocket: { closes: [{ urlPattern: '/ws', probability: 1, code: 1006 }] },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });

    it('rejects close code outside 1000 | 3000-4999', () => {
      const config = {
        websocket: { closes: [{ urlPattern: '/ws', probability: 1, code: 2000 }] },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });

    it('rejects close reason whose UTF-8 encoding exceeds 123 bytes', () => {
      // 124 × 'a' encodes to 124 bytes  -  just over the spec limit.
      const config = {
        websocket: { closes: [{ urlPattern: '/ws', probability: 1, reason: 'a'.repeat(124) }] },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });

    it('rejects close reason whose UTF-8 encoding exceeds 123 bytes for multi-byte chars', () => {
      // '🌀' is 4 UTF-8 bytes; 31 × '🌀' = 124 bytes > 123.
      const config = {
        websocket: { closes: [{ urlPattern: '/ws', probability: 1, reason: '🌀'.repeat(31) }] },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });
  });

  describe('sse config', () => {
    it('accepts valid drop/delay/corrupt/close rules', () => {
      const config = {
        sse: {
          drops: [{ urlPattern: '/sse', probability: 0.5 }],
          delays: [{ urlPattern: '/sse', delayMs: 100, probability: 1 }],
          corruptions: [{ urlPattern: '/sse', strategy: 'truncate' as const, probability: 0.2 }],
          closes: [{ urlPattern: '/sse', afterMs: 500, probability: 1 }],
        },
      };
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('accepts a named eventType', () => {
      const config = {
        sse: { drops: [{ urlPattern: '/sse', eventType: 'tick', probability: 1 }] },
      };
      expect(() => validateConfig(config)).not.toThrow();
    });

    it("accepts '*' eventType wildcard", () => {
      const config = {
        sse: { drops: [{ urlPattern: '/sse', eventType: '*', probability: 1 }] },
      };
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('rejects empty eventType string', () => {
      const config = {
        sse: { drops: [{ urlPattern: '/sse', eventType: '', probability: 1 }] },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });

    it('rejects empty urlPattern', () => {
      const config = {
        sse: { drops: [{ urlPattern: '', probability: 1 }] },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });

    it('rejects negative delayMs', () => {
      const config = {
        sse: { delays: [{ urlPattern: '/sse', delayMs: -1, probability: 1 }] },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });

    it('rejects negative afterMs on close', () => {
      const config = {
        sse: { closes: [{ urlPattern: '/sse', probability: 1, afterMs: -5 }] },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });

    it('rejects multiple counting fields on a single sse rule', () => {
      const config = {
        sse: { drops: [{ urlPattern: '/sse', probability: 1, onNth: 1, everyNth: 2 }] },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });

    it('rejects unknown corruption strategy', () => {
      const config = {
        sse: { corruptions: [{ urlPattern: '/sse', strategy: 'shred' as unknown as 'truncate', probability: 1 }] },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });

    it('rejects unknown keys inside sse (strict)', () => {
      const config = {
        sse: { drops: [], extra: true } as unknown as Record<string, unknown>,
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });
  });

  describe('graphqlOperation matcher', () => {
    it('accepts a string graphqlOperation on every network rule type', () => {
      const config = {
        network: {
          failures: [{ urlPattern: '/graphql', statusCode: 503, probability: 1, graphqlOperation: 'GetUser' }],
          latencies: [{ urlPattern: '/graphql', delayMs: 100, probability: 1, graphqlOperation: 'GetUser' }],
          aborts: [{ urlPattern: '/graphql', probability: 1, graphqlOperation: 'GetUser' }],
          corruptions: [{ urlPattern: '/graphql', probability: 1, strategy: 'truncate' as const, graphqlOperation: 'GetUser' }],
          cors: [{ urlPattern: '/graphql', probability: 1, graphqlOperation: 'GetUser' }],
        },
      };
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('accepts a RegExp graphqlOperation', () => {
      const config = {
        network: {
          failures: [{ urlPattern: '/graphql', statusCode: 500, probability: 1, graphqlOperation: /^Get/ }],
        },
      };
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('rejects an empty graphqlOperation string', () => {
      const config = {
        network: {
          failures: [{ urlPattern: '/graphql', statusCode: 500, probability: 1, graphqlOperation: '' }],
        },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });

    it('rejects a non-string non-RegExp graphqlOperation', () => {
      const config = {
        network: {
          failures: [{ urlPattern: '/graphql', statusCode: 500, probability: 1, graphqlOperation: 42 as unknown as string }],
        },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });

    it('rejects a RegExp graphqlOperation with /g flag', () => {
      const config = {
        network: {
          failures: [{ urlPattern: '/graphql', statusCode: 500, probability: 1, graphqlOperation: /^Get/g }],
        },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });

    it('rejects a RegExp graphqlOperation with /y flag', () => {
      const config = {
        network: {
          failures: [{ urlPattern: '/graphql', statusCode: 500, probability: 1, graphqlOperation: /^Get/y }],
        },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });
  });

  describe('rule groups', () => {
    it('accepts group: "x" on every rule type', () => {
      const config = {
        network: {
          failures: [{ urlPattern: '/x', statusCode: 500, probability: 1, group: 'a' }],
          latencies: [{ urlPattern: '/x', delayMs: 1, probability: 1, group: 'a' }],
          aborts: [{ urlPattern: '/x', probability: 1, group: 'a' }],
          corruptions: [{ urlPattern: '/x', strategy: 'truncate' as const, probability: 1, group: 'a' }],
          cors: [{ urlPattern: '/x', probability: 1, group: 'a' }],
        },
        ui: {
          assaults: [{ selector: '.x', action: 'hide' as const, probability: 1, group: 'a' }],
        },
        websocket: {
          drops: [{ urlPattern: 'ws://x', direction: 'both' as const, probability: 1, group: 'a' }],
          delays: [{ urlPattern: 'ws://x', direction: 'both' as const, delayMs: 1, probability: 1, group: 'a' }],
          corruptions: [{ urlPattern: 'ws://x', direction: 'both' as const, strategy: 'truncate' as const, probability: 1, group: 'a' }],
          closes: [{ urlPattern: 'ws://x', probability: 1, group: 'a' }],
        },
        sse: {
          drops: [{ urlPattern: '/sse', probability: 1, group: 'a' }],
          delays: [{ urlPattern: '/sse', delayMs: 1, probability: 1, group: 'a' }],
          corruptions: [{ urlPattern: '/sse', strategy: 'truncate' as const, probability: 1, group: 'a' }],
          closes: [{ urlPattern: '/sse', probability: 1, group: 'a' }],
        },
      };
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('rejects an empty group field on a rule', () => {
      const config = {
        network: { failures: [{ urlPattern: '/x', statusCode: 500, probability: 1, group: '' }] },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });

    it('rejects a whitespace-only group field on a rule', () => {
      const config = {
        network: { failures: [{ urlPattern: '/x', statusCode: 500, probability: 1, group: '   ' }] },
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });

    it("trims surrounding whitespace on rule's group ('payments ' → 'payments')", () => {
      const config = {
        network: { failures: [{ urlPattern: '/x', statusCode: 500, probability: 1, group: 'payments ' }] },
      };
      const parsed = validateConfig(config);
      expect(parsed.network!.failures![0].group).toBe('payments');
    });

    it('accepts groups: [{ name, enabled }] on the top-level config', () => {
      const config = {
        groups: [
          { name: 'payments', enabled: false },
          { name: 'analytics' },
        ],
      };
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('rejects empty / whitespace-only group name in groups array', () => {
      expect(() => validateConfig({ groups: [{ name: '' }] })).toThrow(ChaosConfigError);
      expect(() => validateConfig({ groups: [{ name: '   ' }] })).toThrow(ChaosConfigError);
    });

    it('trims surrounding whitespace on groups[].name', () => {
      const parsed = validateConfig({ groups: [{ name: 'payments ' }] });
      expect(parsed.groups![0].name).toBe('payments');
    });

    it('rejects duplicate group names after normalization', () => {
      const config = {
        groups: [
          { name: 'payments' },
          { name: ' payments ' },
        ],
      };
      expect(() => validateConfig(config)).toThrow(ChaosConfigError);
    });
  });

  describe('debug option', () => {
    it('accepts debug:true', () => {
      expect(() => validateConfig({ debug: true })).not.toThrow();
    });

    it('accepts debug:false', () => {
      expect(() => validateConfig({ debug: false })).not.toThrow();
    });

    it('accepts debug:{ enabled: true }', () => {
      expect(() => validateConfig({ debug: { enabled: true } })).not.toThrow();
    });

    it('accepts debug:{ enabled: false }', () => {
      expect(() => validateConfig({ debug: { enabled: false } })).not.toThrow();
    });

    it('rejects debug:"yes"', () => {
      expect(() => validateConfig({ debug: 'yes' })).toThrow(ChaosConfigError);
    });

    it('rejects debug:{ enabled: "no" }', () => {
      expect(() => validateConfig({ debug: { enabled: 'no' } })).toThrow(ChaosConfigError);
    });

    it('rejects unknown sub-fields under strict object form', () => {
      expect(() =>
        validateConfig({ debug: { enabled: true, level: 'info' } }),
      ).toThrow(ChaosConfigError);
    });
  });

  describe('presets / customPresets', () => {
    it('accepts a presets array of known names', () => {
      const parsed = validateConfig({ presets: ['slow-api', 'unstableApi'] });
      expect(parsed.presets).toEqual(['slow-api', 'unstableApi']);
    });

    it('rejects an empty preset name', () => {
      expect(() => validateConfig({ presets: [''] })).toThrow(ChaosConfigError);
    });

    it('rejects a whitespace-only preset name', () => {
      expect(() => validateConfig({ presets: ['   '] })).toThrow(ChaosConfigError);
    });

    it('silently dedupes preset names preserving first occurrence', () => {
      const parsed = validateConfig({ presets: ['slow-api', 'slow-api', 'flaky-api', 'slow-api'] });
      expect(parsed.presets).toEqual(['slow-api', 'flaky-api']);
    });

    it('accepts a valid customPresets record', () => {
      const parsed = validateConfig({
        customPresets: {
          'team-flow': {
            network: { failures: [{ urlPattern: '/x', statusCode: 503, probability: 1 }] },
          },
        },
      });
      expect(parsed.customPresets).toBeDefined();
    });

    it('rejects customPresets whose value carries a chained presets field', () => {
      expect(() =>
        validateConfig({
           
          customPresets: { x: { presets: ['y'] } as any },
        }),
      ).toThrow(ChaosConfigError);
    });

    it('rejects customPresets whose value carries seed (forbidden subfield)', () => {
      expect(() =>
        validateConfig({
           
          customPresets: { x: { seed: 1 } as any },
        }),
      ).toThrow(ChaosConfigError);
    });

    it('rejects customPresets whose value carries debug (forbidden subfield)', () => {
      expect(() =>
        validateConfig({
           
          customPresets: { x: { debug: true } as any },
        }),
      ).toThrow(ChaosConfigError);
    });

    it('rejects customPresets whose value carries customPresets (chain attempt)', () => {
      expect(() =>
        validateConfig({
           
          customPresets: { x: { customPresets: { y: {} } } as any },
        }),
      ).toThrow(ChaosConfigError);
    });

    it('rejects an empty customPresets key', () => {
      expect(() => validateConfig({ customPresets: { '': {} } })).toThrow(ChaosConfigError);
    });
  });
});

function captureValidateConfigThrow(fn: () => unknown): ChaosConfigError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ChaosConfigError) return e;
    throw e;
  }
  throw new Error('expected validateConfig to throw ChaosConfigError');
}

describe('ValidationIssue shape', () => {
  it('every issue carries a structured ValidationIssue', () => {
    const err = captureValidateConfigThrow(() =>
      validateConfig({
        network: { failures: [{ urlPattern: '', statusCode: 999, probability: 1.5 }] },
      }),
    );
    for (const issue of err.issues) {
      expect(issue).toHaveProperty('path');
      expect(issue).toHaveProperty('code');
      expect(issue).toHaveProperty('ruleType');
      expect(issue).toHaveProperty('message');
    }
  });

  it('backward-compat messages getter still returns string array', () => {
    const err = captureValidateConfigThrow(() =>
      validateConfig({
        network: { failures: [{ urlPattern: '/a', statusCode: 500, probability: 1.5 }] },
      }),
    );
    expect(Array.isArray(err.messages)).toBe(true);
    expect(err.messages.every((m) => typeof m === 'string')).toBe(true);
  });

  it('cross-feature regression: groups + presets + debug + schemaVersion validates clean', () => {
    expect(() =>
      validateConfig({
        schemaVersion: 1,
        debug: true,
        groups: [{ name: 'payments', enabled: false }],
        customPresets: {
          myPreset: {
            network: { failures: [{ urlPattern: '/api', statusCode: 500, probability: 1, group: 'payments' }] },
          },
        },
        presets: ['myPreset'],
      }),
    ).not.toThrow();
  });
});
