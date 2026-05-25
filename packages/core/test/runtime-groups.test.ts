import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { patchFetch } from '../src/interceptors/networkFetch';
import { NetworkConfig } from '../src/config';
import { ChaosEventEmitter, ChaosEvent } from '../src/events';
import { Logger, buildRuleIdMap } from '../src/debug';
import { RuleGroupRegistry } from '../src/groups';
import { ChaosMaker } from '../src/ChaosMaker';
import { mockFetch } from './setup';

const deterministicRandom = () => 0;

beforeEach(() => {
  mockFetch.mockClear();
  mockFetch.mockResolvedValue(new global.Response('{}', { status: 200 }));
});

// Restore any spies (e.g. console.debug taps) between tests so a failed
// assertion can't leak a mock into the next test's globals.
afterEach(() => {
  vi.restoreAllMocks();
});

describe('runtime group gating  -  network fetch', () => {
  it('skips a rule when its group is disabled (no chaos applied)', async () => {
    const groups = new RuleGroupRegistry();
    groups.ensure('payments', { enabled: false, explicit: true });

    const config: NetworkConfig = {
      failures: [{ urlPattern: '/api/pay', statusCode: 503, probability: 1, group: 'payments' }],
    };
    const emitter = new ChaosEventEmitter();
    const patched = patchFetch(mockFetch, config, deterministicRandom, emitter, new Map(), groups);

    const res = await patched('/api/pay');
    expect((res as { status?: number }).status).toBe(200);
    const fired = emitter.getLog().filter((e) => e.type === 'network:failure' && e.applied);
    expect(fired.length).toBe(0);
  });

  it('emits exactly ONE rule-group:gated event regardless of blocked-request count', async () => {
    const groups = new RuleGroupRegistry();
    groups.ensure('payments', { enabled: false, explicit: true });

    const config: NetworkConfig = {
      failures: [{ urlPattern: '/api/pay', statusCode: 503, probability: 1, group: 'payments' }],
    };
    const emitter = new ChaosEventEmitter();
    const patched = patchFetch(mockFetch, config, deterministicRandom, emitter, new Map(), groups);

    for (let i = 0; i < 50; i++) {
      await patched('/api/pay');
    }
    const gated = emitter.getLog().filter((e) => e.type === 'rule-group:gated');
    expect(gated.length).toBe(1);
    expect(gated[0].detail.groupName).toBe('payments');
    expect(gated[0].applied).toBe(false);
  });

  it('re-enabling and re-disabling emits a fresh gated event next cycle', async () => {
    const groups = new RuleGroupRegistry();
    groups.ensure('payments', { enabled: false, explicit: true });

    const config: NetworkConfig = {
      failures: [{ urlPattern: '/api/pay', statusCode: 503, probability: 1, group: 'payments' }],
    };
    const emitter = new ChaosEventEmitter();
    const patched = patchFetch(mockFetch, config, deterministicRandom, emitter, new Map(), groups);

    await patched('/api/pay'); // emits gated #1
    groups.setEnabled('payments', true);
    await patched('/api/pay'); // chaos fires; status 503
    groups.setEnabled('payments', false);
    await patched('/api/pay'); // emits gated #2 (fresh cycle)
    await patched('/api/pay'); // already-emitted, dedup blocks

    const gated = emitter.getLog().filter((e) => e.type === 'rule-group:gated');
    expect(gated.length).toBe(2);
  });

  it('toggle storm (disable → enable → disable → enable) emits exactly one gated per disabled cycle', async () => {
    const groups = new RuleGroupRegistry();
    groups.ensure('payments', { enabled: false, explicit: true });

    const config: NetworkConfig = {
      failures: [{ urlPattern: '/api/pay', statusCode: 503, probability: 1, group: 'payments' }],
    };
    const emitter = new ChaosEventEmitter();
    const patched = patchFetch(mockFetch, config, deterministicRandom, emitter, new Map(), groups);

    await patched('/api/pay'); // gated #1
    await patched('/api/pay'); // dedup
    groups.setEnabled('payments', true);
    await patched('/api/pay'); // applied
    groups.setEnabled('payments', false);
    await patched('/api/pay'); // gated #2
    await patched('/api/pay'); // dedup
    groups.setEnabled('payments', true);
    await patched('/api/pay'); // applied
    groups.setEnabled('payments', false);
    await patched('/api/pay'); // gated #3

    const gated = emitter.getLog().filter((e) => e.type === 'rule-group:gated');
    expect(gated.length).toBe(3);
  });

  it('ungrouped rules continue firing when another group is disabled', async () => {
    const groups = new RuleGroupRegistry();
    groups.ensure('payments', { enabled: false, explicit: true });

    const config: NetworkConfig = {
      failures: [
        { urlPattern: '/api/pay', statusCode: 503, probability: 1, group: 'payments' },
        { urlPattern: '/api/data', statusCode: 500, probability: 1 }, // ungrouped (default)
      ],
    };
    const emitter = new ChaosEventEmitter();
    const patched = patchFetch(mockFetch, config, deterministicRandom, emitter, new Map(), groups);

    const ungrouped = await patched('/api/data') as { status?: number };
    const gatedRes = await patched('/api/pay') as { status?: number };
    expect(ungrouped.status).toBe(500);
    expect(gatedRes.status).toBe(200);
  });

  it('counters survive a disable→enable→disable cycle (onNth still hits at the right index)', async () => {
    const groups = new RuleGroupRegistry();
    const config: NetworkConfig = {
      failures: [{ urlPattern: '/api/pay', statusCode: 503, probability: 1, onNth: 3, group: 'payments' }],
    };
    const emitter = new ChaosEventEmitter();
    const counters = new Map<object, number>();
    const patched = patchFetch(mockFetch, config, deterministicRandom, emitter, counters, groups);

    // Counter increments even while gated  -  that's intentional so the rule
    // hits its 3rd MATCHING request irrespective of toggle state.
    groups.setEnabled('payments', false);
    await patched('/api/pay'); // count=1, gated
    await patched('/api/pay'); // count=2, gated
    groups.setEnabled('payments', true);
    const r3 = await patched('/api/pay') as { status?: number }; // count=3, fires
    expect(r3.status).toBe(503);
  });

  it('emits a rule-skip-group debug event when group is disabled', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const groups = new RuleGroupRegistry();
    groups.ensure('payments', { enabled: false, explicit: true });

    const failure = { urlPattern: '/api/pay', statusCode: 503, probability: 1, group: 'payments' };
    const config: NetworkConfig = { failures: [failure] };
    const emitter = new ChaosEventEmitter();
    emitter.setLogger(new Logger({ enabled: true }));
    emitter.setRuleIds(buildRuleIdMap({ network: config }));
    const patched = patchFetch(mockFetch, config, deterministicRandom, emitter, new Map(), groups);

    await patched('/api/pay');
    const skipGroup = emitter.getLog().filter(
      (e) => e.type === 'debug' && e.detail.stage === 'rule-skip-group',
    );
    expect(skipGroup.length).toBe(1);
    expect(skipGroup[0].detail.groupName).toBe('payments');
    expect(skipGroup[0].detail.ruleId).toBe('failure#0');
  });
});

describe('ChaosMaker public group API', () => {
  it('exposes enableGroup / disableGroup that emit lifecycle events', () => {
    const cm = new ChaosMaker({});
    const events: ChaosEvent[] = [];
    cm.on('*', (e) => events.push(e));
    cm.disableGroup('payments');
    cm.enableGroup('payments');
    const types = events.map((e) => e.type);
    expect(types).toContain('rule-group:disabled');
    expect(types).toContain('rule-group:enabled');
  });

  it('seedGroupsFromRules populates listGroups before any request fires', () => {
    const cm = new ChaosMaker({
      network: {
        failures: [{ urlPattern: '/x', statusCode: 500, probability: 1, group: 'payments' }],
      },
      websocket: {
        drops: [{ urlPattern: 'ws://x', direction: 'both', probability: 1, group: 'analytics' }],
      },
    });
    const names = cm.listGroups().map((g) => g.name).sort();
    // expect both rule-referenced groups + the default group
    expect(names).toEqual(['analytics', 'default', 'payments']);
  });

  it('removeGroup respects {force} and rejects default', () => {
    const cm = new ChaosMaker({
      network: { failures: [{ urlPattern: '/x', statusCode: 500, probability: 1, group: 'payments' }] },
    });
    expect(cm.removeGroup('default')).toBe(false);
    expect(() => cm.removeGroup('payments')).toThrow(/still referenced/);
    expect(cm.removeGroup('payments', { force: true })).toBe(true);
    expect(cm.hasGroup('payments')).toBe(false);
  });

  it('createGroup with enabled:false ships a group disabled at construction time', () => {
    const cm = new ChaosMaker({});
    cm.createGroup('payments', { enabled: false });
    expect(cm.getGroupState('payments')).toBe(false);
    cm.enableGroup('payments');
    expect(cm.getGroupState('payments')).toBe(true);
  });

  it('public group APIs trim names and reject empty names', () => {
    const cm = new ChaosMaker({});
    cm.createGroup(' payments ', { enabled: false });
    expect(cm.hasGroup(' payments ')).toBe(true);
    expect(cm.getGroupState('payments')).toBe(false);
    cm.enableGroup(' payments ');
    expect(cm.getGroupState(' payments ')).toBe(true);
    cm.disableGroup(' payments ');
    expect(cm.getGroupState('payments')).toBe(false);
    expect(cm.removeGroup(' payments ')).toBe(true);
    expect(() => cm.createGroup('   ')).toThrow('[chaos-maker] Group name cannot be empty');
    expect(() => cm.enableGroup('')).toThrow('[chaos-maker] Group name cannot be empty');
    expect(() => cm.disableGroup('')).toThrow('[chaos-maker] Group name cannot be empty');
    expect(() => cm.removeGroup('')).toThrow('[chaos-maker] Group name cannot be empty');
    expect(() => cm.hasGroup('   ')).toThrow('[chaos-maker] Group name cannot be empty');
    expect(() => cm.getGroupState('')).toThrow('[chaos-maker] Group name cannot be empty');
  });

  it('config.groups pre-registers groups as initially disabled', () => {
    const cm = new ChaosMaker({
      groups: [{ name: 'payments', enabled: false }],
      network: { failures: [{ urlPattern: '/x', statusCode: 500, probability: 1, group: 'payments' }] },
    });
    expect(cm.getGroupState('payments')).toBe(false);
  });

  it('backward compat: a v0.4.x config without groups behaves identically (no group on rules)', () => {
    const cm = new ChaosMaker({
      network: { failures: [{ urlPattern: '/x', statusCode: 500, probability: 1 }] },
    });
    // Only the default group exists; the failure rule retains group: undefined.
    const snapshot = cm.getGroupsSnapshot();
    expect(Object.keys(snapshot)).toEqual(['default']);
  });
});
