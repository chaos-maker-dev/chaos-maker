import type { ChaosConfig, ChaosEvent } from '@chaos-maker/core';

/** Which browser request interceptor a network scenario drives. */
export type ResourceKind = 'fetch' | 'xhr';

/** One observable action or assertion in a parity scenario. The shared catalog
 *  expresses scenarios as ordered Step data so all four adapters execute the
 *  identical sequence through their own interpreter. */
export type Step =
  | { kind: 'click'; selector: string }
  | { kind: 'waitForText'; selector: string; text: string }
  | { kind: 'waitForCount'; selector: string; min: number }
  | { kind: 'expectText'; selector: string; text: string }
  | {
      kind: 'request';
      as: ResourceKind;
      url: string;
      headers?: Record<string, string>;
      capture: string;
    }
  | { kind: 'settle'; ms: number };

/** Inputs to a scenario's final assertion: the chaos event log and any
 *  response statuses recorded by `request` steps, keyed by their `capture`. */
export interface AssertCtx {
  log: ChaosEvent[];
  captured: Record<string, number>;
}

/** Runner-agnostic assertion surface. Each test runner reports failures
 *  differently; the catalog asserts only through these three methods so a
 *  scenario's pass/fail logic is identical on every adapter. The default
 *  implementation in `assertions.ts` throws plain `Error`s, which every
 *  runner treats as a failed test. */
export interface ParityAssert {
  equal(actual: unknown, expected: unknown, message?: string): void;
  notEqual(actual: unknown, expected: unknown, message?: string): void;
  ok(value: unknown, message?: string): void;
}

/** A single matcher parity case. `config` is injected before navigation,
 *  `steps` run in order, then `check` asserts the outcome. Pure data plus
 *  one pure function  -  no dependency on any test runner. */
export interface Scenario {
  /** Stable identifier, e.g. `net-hostname-match`. */
  id: string;
  /** Human-readable test name, used verbatim as the test title on every adapter. */
  title: string;
  /** Transport this scenario exercises. */
  transport: 'network' | 'websocket' | 'sse' | 'fetch-stream';
  config: ChaosConfig;
  steps: Step[];
  check(ctx: AssertCtx, assert: ParityAssert): void;
}
