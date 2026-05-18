import { describe, it, expect } from 'vitest';
import {
  parseRequestUrl,
  matchHostname,
  matchKvEntry,
  matchQueryParams,
  matchHeaders,
  createHeaderView,
  matchResourceType,
} from '../src/matchers';

describe('parseRequestUrl', () => {
  it('returns hostname and searchParams for absolute URLs', () => {
    const parsed = parseRequestUrl('https://api.example.com/users?role=admin&limit=10');
    expect(parsed).not.toBeNull();
    expect(parsed!.hostname).toBe('api.example.com');
    expect(parsed!.searchParams.get('role')).toBe('admin');
    expect(parsed!.searchParams.get('limit')).toBe('10');
  });

  it('resolves relative URLs against fallback base', () => {
    const parsed = parseRequestUrl('/api/users?x=1');
    expect(parsed).not.toBeNull();
    expect(parsed!.searchParams.get('x')).toBe('1');
  });

  it('returns null when the URL constructor throws', () => {
    const originalUrl = globalThis.URL;
    class ThrowingURL {
      constructor() {
        throw new TypeError('boom');
      }
    }
    (globalThis as { URL: typeof globalThis.URL }).URL = ThrowingURL as unknown as typeof globalThis.URL;
    try {
      expect(parseRequestUrl('/anything')).toBeNull();
    } finally {
      (globalThis as { URL: typeof globalThis.URL }).URL = originalUrl;
    }
  });
});

describe('matchHostname', () => {
  it('matches exact strings case-insensitively', () => {
    expect(matchHostname('api.example.com', 'api.example.com')).toBe(true);
    expect(matchHostname('API.Example.COM', 'api.example.com')).toBe(true);
    expect(matchHostname('other.example.com', 'api.example.com')).toBe(false);
  });

  it('uses RegExp.test for regex matchers', () => {
    expect(matchHostname('payments.example.com', /\.example\.com$/)).toBe(true);
    expect(matchHostname('payments.other.com', /\.example\.com$/)).toBe(false);
  });
});

describe('matchKvEntry', () => {
  it('boolean true requires presence', () => {
    expect(matchKvEntry('any', true)).toBe(true);
    expect(matchKvEntry('', true)).toBe(true);
    expect(matchKvEntry(undefined, true)).toBe(false);
  });

  it('boolean false requires absence', () => {
    expect(matchKvEntry(undefined, false)).toBe(true);
    expect(matchKvEntry('any', false)).toBe(false);
  });

  it('string requires exact value', () => {
    expect(matchKvEntry('v1', 'v1')).toBe(true);
    expect(matchKvEntry('v2', 'v1')).toBe(false);
    expect(matchKvEntry(undefined, 'v1')).toBe(false);
  });

  it('RegExp tests the value', () => {
    expect(matchKvEntry('bearer abc', /^bearer /)).toBe(true);
    expect(matchKvEntry('basic xyz', /^bearer /)).toBe(false);
    expect(matchKvEntry(undefined, /^bearer /)).toBe(false);
  });
});

describe('matchQueryParams', () => {
  it('returns true when every requirement passes', () => {
    const params = new URLSearchParams('role=admin&debug=1');
    expect(
      matchQueryParams(params, { role: 'admin', debug: true }),
    ).toBe(true);
  });

  it('returns false when any requirement fails', () => {
    const params = new URLSearchParams('role=user');
    expect(matchQueryParams(params, { role: 'admin' })).toBe(false);
  });

  it('false matcher requires absence of the key', () => {
    const params = new URLSearchParams('role=admin');
    expect(matchQueryParams(params, { debug: false })).toBe(true);
    expect(matchQueryParams(params, { role: false })).toBe(false);
  });

  it('RegExp matches against the value', () => {
    const params = new URLSearchParams('cursor=abc123');
    expect(matchQueryParams(params, { cursor: /^abc/ })).toBe(true);
    expect(matchQueryParams(params, { cursor: /^xyz/ })).toBe(false);
  });

  it('string matcher hits any occurrence when key is repeated', () => {
    const params = new URLSearchParams('role=admin&role=user');
    expect(matchQueryParams(params, { role: 'user' })).toBe(true);
    expect(matchQueryParams(params, { role: 'admin' })).toBe(true);
    expect(matchQueryParams(params, { role: 'guest' })).toBe(false);
  });

  it('RegExp matcher hits any occurrence when key is repeated', () => {
    const params = new URLSearchParams('tag=alpha&tag=beta-build');
    expect(matchQueryParams(params, { tag: /^beta/ })).toBe(true);
    expect(matchQueryParams(params, { tag: /^gamma/ })).toBe(false);
  });

  it('true matcher passes when key repeats; false matcher fails on any occurrence', () => {
    const params = new URLSearchParams('flag=&flag=on');
    expect(matchQueryParams(params, { flag: true })).toBe(true);
    expect(matchQueryParams(params, { flag: false })).toBe(false);
  });
});

describe('createHeaderView and matchHeaders', () => {
  it('lookups are case-insensitive across object inputs', () => {
    const view = createHeaderView({ 'X-Trace-Id': 'abc', Authorization: 'Bearer x' });
    expect(view.has('x-trace-id')).toBe(true);
    expect(view.get('AUTHORIZATION')).toBe('Bearer x');
  });

  it('supports array-of-tuple header inputs', () => {
    const view = createHeaderView([
      ['X-Trace-Id', 'abc'],
      ['Authorization', 'Bearer x'],
    ]);
    expect(view.get('x-trace-id')).toBe('abc');
  });

  it('supports Map inputs', () => {
    const view = createHeaderView(new Map([['X-Trace-Id', 'abc']]));
    expect(view.get('x-trace-id')).toBe('abc');
  });

  it('matchHeaders applies every requirement', () => {
    const view = createHeaderView({ Authorization: 'Bearer abc', 'X-Tenant': 'acme' });
    expect(
      matchHeaders(view, {
        authorization: /^bearer /i,
        'x-tenant': 'acme',
        'x-missing': false,
      }),
    ).toBe(true);
  });

  it('matchHeaders returns false when any requirement fails', () => {
    const view = createHeaderView({ Authorization: 'Basic abc' });
    expect(matchHeaders(view, { authorization: /^bearer /i })).toBe(false);
  });
});

describe('matchResourceType', () => {
  it('returns true when allowed list is empty or omitted', () => {
    expect(matchResourceType('fetch', undefined)).toBe(true);
    expect(matchResourceType('fetch', [])).toBe(true);
  });

  it('returns true when actual is in allowed list', () => {
    expect(matchResourceType('fetch', ['fetch', 'xhr'])).toBe(true);
    expect(matchResourceType('xhr', ['xhr'])).toBe(true);
  });

  it('returns false when actual is not in allowed list', () => {
    expect(matchResourceType('fetch', ['xhr'])).toBe(false);
  });
});
