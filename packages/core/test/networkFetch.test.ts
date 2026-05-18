import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { patchFetch } from '../src/interceptors/networkFetch';
import { NetworkConfig } from '../src/config';
import { ChaosEventEmitter } from '../src/events';
import { RuleGroupRegistry } from '../src/groups';
// Import the mock from setup.ts
import { mockFetch } from './setup';

// Get the mock fetch from our setup file
const originalFetch = mockFetch;
const deterministicRandom = () => 0;

function createAbortAwareFetch() {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) {
      reject(new Error('Missing signal'));
      return;
    }

    const rejectWithAbort = () => {
      reject(signal.reason ?? new DOMException('The user aborted a request.', 'AbortError'));
    };

    if (signal.aborted) {
      rejectWithAbort();
      return;
    }

    signal.addEventListener('abort', rejectWithAbort, { once: true });
  }));
}

beforeEach(() => {
  // Reset mock call history before each test
  originalFetch.mockClear();
  originalFetch.mockResolvedValue(new global.Response('{}', { status: 200 }));
  // Restore the original implementation in case a test patches it
  global.fetch = originalFetch; 
});

describe('patchFetch', () => {
  it('should not intercept requests if config is empty', async () => {
    const config: NetworkConfig = {};
    const patchedFetch = patchFetch(originalFetch, config, deterministicRandom);

    await patchedFetch('/api/test');
    expect(originalFetch).toHaveBeenCalledWith('/api/test', undefined);
  });

  it('should force a 503 failure for a matching URL', async () => {
    const config: NetworkConfig = {
      failures: [{ urlPattern: '/api/fail', statusCode: 503, probability: 1.0 }]
    };
    const patchedFetch = patchFetch(originalFetch, config, deterministicRandom);

    const response = await patchedFetch('/api/fail');
    
    expect(response.status).toBe(503);
    expect(originalFetch).not.toHaveBeenCalled();
  });

  it('should not intercept a non-matching URL', async () => {
    const config: NetworkConfig = {
      failures: [{ urlPattern: '/api/fail', statusCode: 503, probability: 1.0 }]
    };
    const patchedFetch = patchFetch(originalFetch, config, deterministicRandom);

    await patchedFetch('/api/success');
    
    expect(originalFetch).toHaveBeenCalledWith('/api/success', undefined);
    expect(originalFetch).toHaveBeenCalledTimes(1);
  });

  it('should only intercept matching methods', async () => {
    const config: NetworkConfig = {
      failures: [{ urlPattern: '/api/data', methods: ['POST'], statusCode: 500, probability: 1.0 }]
    };
    const patchedFetch = patchFetch(originalFetch, config, deterministicRandom);

    // This one should pass through
    await patchedFetch('/api/data', { method: 'GET' });
    expect(originalFetch).toHaveBeenCalled();
    
    originalFetch.mockClear();

    // This one should fail
    const response = await patchedFetch('/api/data', { method: 'POST' });
    expect(response.status).toBe(500);
    expect(originalFetch).not.toHaveBeenCalled();
  });

  it('should add latency to a matching request', async () => {
    const config: NetworkConfig = {
      latencies: [{ urlPattern: '/api/slow', delayMs: 100, probability: 1.0 }]
    };
    const patchedFetch = patchFetch(originalFetch, config, deterministicRandom);

    const startTime = Date.now();
    await patchedFetch('/api/slow');
    const endTime = Date.now();

    expect(endTime - startTime).toBeGreaterThanOrEqual(95);
    expect(originalFetch).toHaveBeenCalledWith('/api/slow', undefined);
  });

  it('should respect probability for failures', async () => {
    const config: NetworkConfig = {
      failures: [{ urlPattern: '/api/flaky', statusCode: 500, probability: 0.0 }]
    };
    const patchedFetch = patchFetch(originalFetch, config, deterministicRandom);

    // With 0 probability, should always call original
    await patchedFetch('/api/flaky');
    expect(originalFetch).toHaveBeenCalled();
  });

  it('should force a CORS error for a matching URL', async () => {
    const config: NetworkConfig = {
      cors: [{ urlPattern: '/api/cors', probability: 1.0 }]
    };
    const patchedFetch = patchFetch(originalFetch, config, deterministicRandom);

    await expect(patchedFetch('/api/cors')).rejects.toThrow('Failed to fetch');
    expect(originalFetch).not.toHaveBeenCalled();
  });

  it('should throw an AbortError for a matching URL immediately without timeout', async () => {
    const config: NetworkConfig = {
      aborts: [{ urlPattern: '/api/abort', probability: 1.0 }]
    };
    const abortAwareFetch = createAbortAwareFetch();
    const patchedFetch = patchFetch(abortAwareFetch as typeof global.fetch, config, deterministicRandom);

    await expect(patchedFetch('/api/abort')).rejects.toThrow('The user aborted a request.');
    expect(abortAwareFetch).toHaveBeenCalledTimes(1);
    const [, requestInit] = abortAwareFetch.mock.calls[0];
    expect(requestInit?.signal).toBeDefined();
    expect(requestInit?.signal?.aborted).toBe(true);
  });

  it('should throw an AbortError for a matching URL after a delay if timeout is set', async () => {
    vi.useFakeTimers();
    const config: NetworkConfig = {
      aborts: [{ urlPattern: '/api/abort-delay', timeout: 100, probability: 1.0 }]
    };
    const abortAwareFetch = createAbortAwareFetch();
    const patchedFetch = patchFetch(abortAwareFetch as typeof global.fetch, config, deterministicRandom);

    const requestPromise = patchedFetch('/api/abort-delay');
    expect(abortAwareFetch).toHaveBeenCalledTimes(1);

    const [, requestInit] = abortAwareFetch.mock.calls[0];
    expect(requestInit?.signal?.aborted).toBe(false);

    const rejectionAssertion = requestPromise.then(
      () => {
        throw new Error('Expected request to abort');
      },
      (error) => {
        expect(error).toMatchObject({
          name: 'AbortError',
          message: 'The user aborted a request.',
        });
      }
    );
    await vi.advanceTimersByTimeAsync(100);

    await rejectionAssertion;
    expect(requestInit?.signal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it('should corrupt response text according to truncate strategy', async () => {
    const config: NetworkConfig = {
      corruptions: [{ urlPattern: '/api/corrupt', strategy: 'truncate', probability: 1.0 }]
    };
    const patchedFetch = patchFetch(originalFetch, config, deterministicRandom);
    originalFetch.mockResolvedValueOnce(new global.Response('HelloWorld', { status: 200 }));

    const response = await patchedFetch('/api/corrupt');
    const text = await response.text();
    expect(text).toBe('Hello');
  });

  it('should corrupt response text according to malformed-json strategy', async () => {
    const config: NetworkConfig = {
      corruptions: [{ urlPattern: '/api/corrupt', strategy: 'malformed-json', probability: 1.0 }]
    };
    const patchedFetch = patchFetch(originalFetch, config, deterministicRandom);
    originalFetch.mockResolvedValueOnce(new global.Response('{"key":"value"}', { status: 200 }));

    const response = await patchedFetch('/api/corrupt');
    const text = await response.text();
    expect(text).toBe('{"key":"value"}"}');
  });

  it('should corrupt response text according to empty strategy', async () => {
    const config: NetworkConfig = {
      corruptions: [{ urlPattern: '/api/corrupt', strategy: 'empty', probability: 1.0 }]
    };
    const patchedFetch = patchFetch(originalFetch, config, deterministicRandom);
    originalFetch.mockResolvedValueOnce(new global.Response('HelloWorld', { status: 200 }));

    const response = await patchedFetch('/api/corrupt');
    const text = await response.text();
    expect(text).toBe('');
  });

  it('should corrupt response text according to wrong-type strategy', async () => {
    const config: NetworkConfig = {
      corruptions: [{ urlPattern: '/api/corrupt', strategy: 'wrong-type', probability: 1.0 }]
    };
    const patchedFetch = patchFetch(originalFetch, config, deterministicRandom);
    originalFetch.mockResolvedValueOnce(new global.Response('HelloWorld', { status: 200 }));

    const response = await patchedFetch('/api/corrupt');
    const text = await response.text();
    expect(text).toBe('<html><body>Unexpected HTML</body></html>');
  });

  it('should log corruption as not applied when fetch fails before a response is available', async () => {
    const emitter = new ChaosEventEmitter();
    const failingFetch = vi.fn().mockRejectedValue(new Error('boom'));
    const config: NetworkConfig = {
      corruptions: [{ urlPattern: '/api/corrupt', strategy: 'truncate', probability: 1.0 }]
    };
    const patchedFetch = patchFetch(failingFetch as typeof global.fetch, config, deterministicRandom, emitter);

    await expect(patchedFetch('/api/corrupt')).rejects.toThrow('boom');
    expect(emitter.getLog()).toEqual([
      expect.objectContaining({
        type: 'network:corruption',
        applied: false,
        detail: expect.objectContaining({
          url: '/api/corrupt',
          method: 'GET',
          strategy: 'truncate',
        }),
      }),
    ]);
  });

  describe('graphqlOperation matching', () => {
    it('fires only on the rule whose graphqlOperation matches the POST body operationName', async () => {
      const emitter = new ChaosEventEmitter();
      const config: NetworkConfig = {
        failures: [
          { urlPattern: '/graphql', statusCode: 503, probability: 1, graphqlOperation: 'GetUser' },
          { urlPattern: '/graphql', statusCode: 401, probability: 1, graphqlOperation: 'CreatePost' },
        ],
      };
      const patchedFetch = patchFetch(originalFetch, config, deterministicRandom, emitter);

      const response = await patchedFetch('/graphql', {
        method: 'POST',
        body: JSON.stringify({ operationName: 'GetUser', query: 'query GetUser { user { id } }' }),
      });

      expect(response.status).toBe(503);
      const failures = emitter.getLog().filter(e => e.type === 'network:failure');
      expect(failures).toHaveLength(1);
      expect(failures[0].applied).toBe(true);
      expect(failures[0].detail.operationName).toBe('GetUser');
      expect(failures[0].detail.statusCode).toBe(503);
    });

    it('falls back to parsing operationName from the query field when operationName is absent', async () => {
      const emitter = new ChaosEventEmitter();
      const config: NetworkConfig = {
        failures: [{ urlPattern: '/graphql', statusCode: 500, probability: 1, graphqlOperation: 'GetUser' }],
      };
      const patchedFetch = patchFetch(originalFetch, config, deterministicRandom, emitter);

      const response = await patchedFetch('/graphql', {
        method: 'POST',
        body: JSON.stringify({ query: 'query GetUser { user { id } }' }),
      });

      expect(response.status).toBe(500);
      expect(emitter.getLog()[0].detail.operationName).toBe('GetUser');
    });

    it('matches on persisted-query GET requests via ?operationName=', async () => {
      const emitter = new ChaosEventEmitter();
      const config: NetworkConfig = {
        failures: [{ urlPattern: '/graphql', statusCode: 502, probability: 1, graphqlOperation: 'GetUser' }],
      };
      const patchedFetch = patchFetch(originalFetch, config, deterministicRandom, emitter);

      const response = await patchedFetch('http://example.com/graphql?operationName=GetUser&id=1');

      expect(response.status).toBe(502);
      expect(emitter.getLog()[0].detail.operationName).toBe('GetUser');
    });

    it('skips a rule whose graphqlOperation does not match the request', async () => {
      const config: NetworkConfig = {
        failures: [{ urlPattern: '/graphql', statusCode: 500, probability: 1, graphqlOperation: 'CreatePost' }],
      };
      const patchedFetch = patchFetch(originalFetch, config, deterministicRandom);

      await patchedFetch('/graphql', {
        method: 'POST',
        body: JSON.stringify({ operationName: 'GetUser', query: 'query GetUser { user { id } }' }),
      });

      // Original fetch passed through — chaos rule didn't match.
      expect(originalFetch).toHaveBeenCalledTimes(1);
    });

    it('combines urlPattern, methods, and graphqlOperation as AND filters', async () => {
      const emitter = new ChaosEventEmitter();
      const config: NetworkConfig = {
        failures: [{
          urlPattern: '/graphql',
          methods: ['POST'],
          statusCode: 503,
          probability: 1,
          graphqlOperation: 'GetUser',
        }],
      };
      const patchedFetch = patchFetch(originalFetch, config, deterministicRandom, emitter);

      // Wrong op: GetProducts — should pass through.
      await patchedFetch('/graphql', {
        method: 'POST',
        body: JSON.stringify({ operationName: 'GetProducts' }),
      });
      expect(originalFetch).toHaveBeenCalledTimes(1);

      // Right op + right url + right method: should fail.
      const r = await patchedFetch('/graphql', {
        method: 'POST',
        body: JSON.stringify({ operationName: 'GetUser' }),
      });
      expect(r.status).toBe(503);
    });

    it('matches via a RegExp graphqlOperation', async () => {
      const emitter = new ChaosEventEmitter();
      const config: NetworkConfig = {
        latencies: [{ urlPattern: '/graphql', delayMs: 0, probability: 1, graphqlOperation: /^Get/ }],
      };
      const patchedFetch = patchFetch(originalFetch, config, deterministicRandom, emitter);

      await patchedFetch('/graphql', {
        method: 'POST',
        body: JSON.stringify({ operationName: 'GetUser' }),
      });
      const matched = emitter.getLog().filter(e => e.type === 'network:latency' && e.applied);
      expect(matched).toHaveLength(1);
      expect(matched[0].detail.operationName).toBe('GetUser');
    });

    it('emits a graphql-body-unparseable diagnostic when body is multipart and rule has graphqlOperation', async () => {
      const emitter = new ChaosEventEmitter();
      const config: NetworkConfig = {
        failures: [{ urlPattern: '/graphql', statusCode: 500, probability: 1, graphqlOperation: 'GetUser' }],
      };
      const patchedFetch = patchFetch(originalFetch, config, deterministicRandom, emitter);

      const form = new FormData();
      form.append('operations', JSON.stringify({ operationName: 'GetUser', query: 'query GetUser { user { id } }' }));
      form.append('0', new Blob(['x'], { type: 'text/plain' }));

      await patchedFetch('/graphql', { method: 'POST', body: form });

      // Chaos must NOT have applied — body unparseable.
      expect(originalFetch).toHaveBeenCalledTimes(1);
      const diag = emitter.getLog().find(e => e.detail.reason === 'graphql-body-unparseable');
      expect(diag).toBeDefined();
      expect(diag?.applied).toBe(false);
      expect(diag?.type).toBe('network:failure');
    });

    it('suppresses graphql-body-unparseable diagnostics while the matching group is disabled', async () => {
      const emitter = new ChaosEventEmitter();
      const groups = new RuleGroupRegistry();
      groups.ensure('payments', { enabled: false, explicit: true });
      const config: NetworkConfig = {
        failures: [{
          urlPattern: '/graphql',
          statusCode: 500,
          probability: 1,
          graphqlOperation: 'GetUser',
          group: 'payments',
        }],
      };
      const patchedFetch = patchFetch(originalFetch, config, deterministicRandom, emitter, new Map(), groups);

      const form = new FormData();
      form.append('operations', JSON.stringify({ operationName: 'GetUser', query: 'query GetUser { user { id } }' }));

      await patchedFetch('/graphql', { method: 'POST', body: form });

      expect(originalFetch).toHaveBeenCalledTimes(1);
      expect(emitter.getLog().some(e => e.detail.reason === 'graphql-body-unparseable')).toBe(false);
      expect(emitter.getLog()).toEqual([
        expect.objectContaining({
          type: 'rule-group:gated',
          applied: false,
          detail: expect.objectContaining({ groupName: 'payments' }),
        }),
      ]);
    });

    it('emits graphql-body-unparseable diagnostics only after group and probability pass', async () => {
      const emitter = new ChaosEventEmitter();
      const groups = new RuleGroupRegistry();
      groups.ensure('payments', { enabled: true, explicit: true });
      const config: NetworkConfig = {
        failures: [{
          urlPattern: '/graphql',
          statusCode: 500,
          probability: 1,
          graphqlOperation: 'GetUser',
          group: 'payments',
        }],
      };
      const patchedFetch = patchFetch(originalFetch, config, deterministicRandom, emitter, new Map(), groups);

      const form = new FormData();
      form.append('operations', JSON.stringify({ operationName: 'GetUser', query: 'query GetUser { user { id } }' }));

      await patchedFetch('/graphql', { method: 'POST', body: form });

      expect(originalFetch).toHaveBeenCalledTimes(1);
      const diag = emitter.getLog().find(e => e.detail.reason === 'graphql-body-unparseable');
      expect(diag).toBeDefined();
      expect(diag?.type).toBe('network:failure');
      expect(diag?.applied).toBe(false);
    });

    it('suppresses graphql-body-unparseable diagnostics when probability misses', async () => {
      const emitter = new ChaosEventEmitter();
      const config: NetworkConfig = {
        failures: [{
          urlPattern: '/graphql',
          statusCode: 500,
          probability: 0,
          graphqlOperation: 'GetUser',
        }],
      };
      const patchedFetch = patchFetch(originalFetch, config, deterministicRandom, emitter);

      const form = new FormData();
      form.append('operations', JSON.stringify({ operationName: 'GetUser', query: 'query GetUser { user { id } }' }));

      await patchedFetch('/graphql', { method: 'POST', body: form });

      expect(originalFetch).toHaveBeenCalledTimes(1);
      expect(emitter.getLog().some(e => e.detail.reason === 'graphql-body-unparseable')).toBe(false);
    });

    it('skips body extraction entirely when no rule has graphqlOperation (fast path)', async () => {
      // The body extractor would call .clone() on a Request — this test passes
      // a Request and asserts the body wasn't read by chaos when no rule
      // declares a graphqlOperation matcher. URL-only chaos still fires.
      const config: NetworkConfig = {
        failures: [{ urlPattern: '/graphql', statusCode: 500, probability: 1 }],
      };
      const patchedFetch = patchFetch(originalFetch, config, deterministicRandom);

      const req = new Request('http://example.com/graphql', {
        method: 'POST',
        body: JSON.stringify({ operationName: 'GetUser' }),
      });
      const cloneSpy = vi.spyOn(req, 'clone');

      const r = await patchedFetch(req);
      expect(r.status).toBe(500);
      expect(cloneSpy).not.toHaveBeenCalled();
    });

    it('skips rules whose graphqlOperation does not match without consuming the request body for downstream', async () => {
      // Body must remain readable by the original fetch when chaos doesn't apply.
      // We assert the request reaches originalFetch with a body the consumer
      // can clone and re-read — i.e. patchFetch must not lock the stream.
      const config: NetworkConfig = {
        failures: [{ urlPattern: '/graphql', statusCode: 500, probability: 1, graphqlOperation: 'WrongOp' }],
      };
      const patchedFetch = patchFetch(originalFetch, config, deterministicRandom);

      const req = new Request('http://example.com/graphql', {
        method: 'POST',
        body: JSON.stringify({ operationName: 'GetUser', query: 'query GetUser { user { id } }' }),
      });
      await patchedFetch(req);
      expect(originalFetch).toHaveBeenCalledTimes(1);
      // Original Request body must not be consumed by chaos extraction.
      expect(req.bodyUsed).toBe(false);
    });
  });

  it('should log abort as not applied when the request completes before the timeout fires', async () => {
    vi.useFakeTimers();
    const emitter = new ChaosEventEmitter();
    const fastFetch = vi.fn().mockResolvedValue(new global.Response('{}', { status: 200 }));
    const config: NetworkConfig = {
      aborts: [{ urlPattern: '/api/fast', timeout: 100, probability: 1.0 }]
    };
    const patchedFetch = patchFetch(fastFetch as typeof global.fetch, config, deterministicRandom, emitter);

    const response = await patchedFetch('/api/fast');
    expect(response.status).toBe(200);

    // Advance past the timeout to prove the timer was cancelled
    await vi.advanceTimersByTimeAsync(200);

    expect(emitter.getLog()).toHaveLength(1);
    expect(emitter.getLog()).toEqual([
      expect.objectContaining({
        type: 'network:abort',
        applied: false,
        detail: expect.objectContaining({
          url: '/api/fast',
          method: 'GET',
          timeoutMs: 100,
        }),
      }),
    ]);
    vi.useRealTimers();
  });

  describe('debug logging', () => {
    let debugSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    });

    // Restore the spy between tests so a stacked `vi.spyOn` cannot accumulate
    // across tests if any assertion in the it() block fails.
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('emits rule-evaluating, rule-matched, rule-applied for an applied failure', async () => {
      const { Logger } = await import('../src/debug');
      const { buildRuleIdMap } = await import('../src/debug');
      const failure = { urlPattern: '/api/fail', statusCode: 503, probability: 1.0 };
      const config: NetworkConfig = { failures: [failure] };
      const emitter = new ChaosEventEmitter();
      emitter.setLogger(new Logger({ enabled: true }));
      emitter.setRuleIds(buildRuleIdMap({ network: config }));

      const patched = patchFetch(originalFetch, config, deterministicRandom, emitter);
      await patched('/api/fail');

      const debugEvents = emitter.getLog().filter((e) => e.type === 'debug');
      const stages = debugEvents.map((e) => e.detail.stage);
      expect(stages).toEqual(['rule-evaluating', 'rule-matched', 'rule-applied']);
      for (const e of debugEvents) {
        expect(e.detail.ruleType).toBe('failure');
        expect(e.detail.ruleId).toBe('failure#0');
      }
      // Console mirror: at least one [Chaos] line per event.
      const chaosLines = debugSpy.mock.calls.filter(
        (args) => typeof args[0] === 'string' && (args[0] as string).startsWith('[Chaos] '),
      );
      expect(chaosLines.length).toBe(debugEvents.length);
    });

    it('emits rule-skip-match when matcher rejects', async () => {
      const { Logger, buildRuleIdMap } = await import('../src/debug');
      const failure = { urlPattern: '/api/fail', statusCode: 503, probability: 1.0 };
      const config: NetworkConfig = { failures: [failure] };
      const emitter = new ChaosEventEmitter();
      emitter.setLogger(new Logger({ enabled: true }));
      emitter.setRuleIds(buildRuleIdMap({ network: config }));

      const patched = patchFetch(originalFetch, config, deterministicRandom, emitter);
      await patched('/api/other');

      const debugEvents = emitter.getLog().filter((e) => e.type === 'debug');
      const stages = debugEvents.map((e) => e.detail.stage);
      expect(stages).toEqual(['rule-evaluating', 'rule-skip-match']);
    });

    it('emits rule-skip-counting when counting condition rejects', async () => {
      const { Logger, buildRuleIdMap } = await import('../src/debug');
      const failure = { urlPattern: '/api/fail', statusCode: 503, probability: 1.0, onNth: 5 };
      const config: NetworkConfig = { failures: [failure] };
      const emitter = new ChaosEventEmitter();
      emitter.setLogger(new Logger({ enabled: true }));
      emitter.setRuleIds(buildRuleIdMap({ network: config }));

      const patched = patchFetch(originalFetch, config, deterministicRandom, emitter);
      await patched('/api/fail');

      const debugEvents = emitter.getLog().filter((e) => e.type === 'debug');
      expect(debugEvents.map((e) => e.detail.stage)).toEqual([
        'rule-evaluating',
        'rule-matched',
        'rule-skip-counting',
      ]);
    });

    it('emits rule-skip-probability when probability roll misses', async () => {
      const { Logger, buildRuleIdMap } = await import('../src/debug');
      const failure = { urlPattern: '/api/fail', statusCode: 503, probability: 0 };
      const config: NetworkConfig = { failures: [failure] };
      const emitter = new ChaosEventEmitter();
      emitter.setLogger(new Logger({ enabled: true }));
      emitter.setRuleIds(buildRuleIdMap({ network: config }));

      const patched = patchFetch(originalFetch, config, deterministicRandom, emitter);
      await patched('/api/fail');

      const debugEvents = emitter.getLog().filter((e) => e.type === 'debug');
      expect(debugEvents.map((e) => e.detail.stage)).toEqual([
        'rule-evaluating',
        'rule-matched',
        'rule-skip-probability',
      ]);
    });
  });

  describe('advanced matchers', () => {
    it('hostname matcher fires only when hostname matches', async () => {
      const config: NetworkConfig = {
        failures: [
          { urlPattern: '*', hostname: 'api.example.com', statusCode: 503, probability: 1 },
        ],
      };
      const patched = patchFetch(originalFetch, config, deterministicRandom);
      const a = await patched('https://api.example.com/users');
      const b = await patched('https://other.example.com/users');
      expect(a.status).toBe(503);
      expect(b.status).toBe(200);
    });

    it('hostname RegExp matcher tests against the hostname', async () => {
      const config: NetworkConfig = {
        failures: [
          { urlPattern: '*', hostname: /\.example\.com$/, statusCode: 503, probability: 1 },
        ],
      };
      const patched = patchFetch(originalFetch, config, deterministicRandom);
      const a = await patched('https://payments.example.com/charges');
      const b = await patched('https://other.test/charges');
      expect(a.status).toBe(503);
      expect(b.status).toBe(200);
    });

    it('queryParams matcher requires every entry to pass', async () => {
      const config: NetworkConfig = {
        failures: [
          {
            urlPattern: '/api',
            queryParams: { role: 'admin', debug: true },
            statusCode: 503,
            probability: 1,
          },
        ],
      };
      const patched = patchFetch(originalFetch, config, deterministicRandom);
      const match = await patched('/api/users?role=admin&debug=1');
      const missingDebug = await patched('/api/users?role=admin');
      const wrongRole = await patched('/api/users?role=user&debug=1');
      expect(match.status).toBe(503);
      expect(missingDebug.status).toBe(200);
      expect(wrongRole.status).toBe(200);
    });

    it('headers matcher is case-insensitive on the key', async () => {
      const config: NetworkConfig = {
        failures: [
          {
            urlPattern: '/api',
            headers: { authorization: /^Bearer / },
            statusCode: 503,
            probability: 1,
          },
        ],
      };
      const patched = patchFetch(originalFetch, config, deterministicRandom);
      const match = await patched('/api/users', { headers: { Authorization: 'Bearer abc' } });
      const miss = await patched('/api/users', { headers: { Authorization: 'Basic xyz' } });
      expect(match.status).toBe(503);
      expect(miss.status).toBe(200);
    });

    it('resourceTypes restricted to xhr does not fire on fetch', async () => {
      const config: NetworkConfig = {
        failures: [
          { urlPattern: '/api', resourceTypes: ['xhr'], statusCode: 503, probability: 1 },
        ],
      };
      const patched = patchFetch(originalFetch, config, deterministicRandom);
      const res = await patched('/api/users');
      expect(res.status).toBe(200);
    });

    it('resourceTypes including fetch allows the rule to fire', async () => {
      const config: NetworkConfig = {
        failures: [
          { urlPattern: '/api', resourceTypes: ['fetch'], statusCode: 503, probability: 1 },
        ],
      };
      const patched = patchFetch(originalFetch, config, deterministicRandom);
      const res = await patched('/api/users');
      expect(res.status).toBe(503);
    });

    it('combined matchers must all pass to fire', async () => {
      const config: NetworkConfig = {
        failures: [
          {
            urlPattern: '*',
            hostname: 'api.example.com',
            methods: ['POST'],
            queryParams: { tenant: 'acme' },
            headers: { 'x-trace-id': true },
            statusCode: 503,
            probability: 1,
          },
        ],
      };
      const patched = patchFetch(originalFetch, config, deterministicRandom);
      const allMatch = await patched('https://api.example.com/charge?tenant=acme', {
        method: 'POST',
        headers: { 'X-Trace-Id': 'abc' },
      });
      const wrongHost = await patched('https://other.test/charge?tenant=acme', {
        method: 'POST',
        headers: { 'X-Trace-Id': 'abc' },
      });
      const missingHeader = await patched('https://api.example.com/charge?tenant=acme', {
        method: 'POST',
      });
      expect(allMatch.status).toBe(503);
      expect(wrongHost.status).toBe(200);
      expect(missingHeader.status).toBe(200);
    });
  });
});
