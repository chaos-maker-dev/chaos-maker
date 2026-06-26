/**
 * AI DSL compiler.
 *
 * The `ai` namespace on `ChaosConfig` is a thin shorthand that expands into
 * transport-layer rule arrays (`fetchStream`, `sse`, `websocket`) at engine
 * init  -  the runtime never sees the `ai` slice itself. Reporting picks up
 * the semantic overlay via `detail.phase` (set by the interceptors, not by
 * this compiler).
 *
 * Single source of truth: `AI_TRANSLATIONS` below. Each entry maps one
 * `AiConfig` field to a `compile` function that appends transport rules.
 * Adding a new `AiConfig` field WITHOUT adding a translation row fails the
 * drift-detection test in `ai/__tests__/translate.test.ts`.
 *
 * Transport selection (`ai.transport`):
 *   - `'auto'` / unset: emit rules into fetchStream + sse + websocket so the
 *     same `ai` slice fires for whichever streaming transport the consumer
 *     happens to use.
 *   - explicit kind: emit rules only into that transport.
 *
 * Transport coverage notes (transports that cannot model an AI field skip
 * it silently rather than failing validation):
 *   - `firstChunkDelayMs`: fetchStream uses `chunkIndex: 0`; sse + ws use
 *     `onNth: 1` (first matched message).
 *   - `pauseAfterChunk`: fetchStream uses `chunkIndex: K`; sse + ws use
 *     `onNth: K + 1` (1-based position).
 *   - `truncateAfterChunk`: fetchStream uses `afterChunk: K`; sse + ws have
 *     no after-N-message close shape, so this AI field skips them. A close
 *     event still fires on those transports under user-defined `closes`.
 *   - `duplicateChunkProbability`: fetchStream uses the dedicated
 *     `'duplicate'` corruption strategy. sse + ws corruption strategies do
 *     not include `'duplicate'` today, so this AI field skips them.
 *   - `reconnectAfterDrop`: passive flag carried on the compile context for
 *     future drop-rule annotation; no rules are emitted today.
 */

import type {
  AiConfig,
  AiTransport,
  ChaosConfig,
  FetchStreamConfig,
  SSEConfig,
  WebSocketConfig,
} from '../config';

/** Output of one translation row: a list of mutator functions that append
 *  rules onto the working chaos config. The compiler invokes each appender
 *  inside `compileAiToRules`. */
export interface TransportRuleAppender {
  apply: (cfg: ChaosConfig) => void;
}

/** Resolved context passed to every translation `compile` call. */
export interface AiCompileContext {
  /** Concrete target transports after resolving `ai.transport` ('auto' →
   *  all three streaming transports). */
  readonly transports: ReadonlyArray<Exclude<AiTransport, 'auto'>>;
  /** Passive flag for translations that need to know whether reconnect was
   *  requested. Compilers may ignore it; today no row consumes it. */
  readonly reconnectAfterDrop: boolean;
  /** Default urlPattern used when the AI slice does not target a specific
   *  URL. `'*'` matches every streaming request. */
  readonly urlPattern: string;
}

export interface AiTranslation<K extends keyof AiConfig = keyof AiConfig> {
  readonly aiField: K;
  readonly description: string;
  readonly compile: (
    value: NonNullable<AiConfig[K]>,
    ctx: AiCompileContext,
    config: Readonly<AiConfig>,
  ) => TransportRuleAppender[];
}

/** Type-erased shape used by the iterating compiler. Each row in
 *  `AI_TRANSLATIONS` keeps a precise generic type (`AiTranslation<'firstChunkDelayMs'>`,
 *  ...) for clarity at the call site, then projects through this erased type
 *  so the array can be a single homogeneous list. */
export type AnyAiTranslation = {
  readonly aiField: keyof AiConfig;
  readonly description: string;
  readonly compile: (
    value: unknown,
    ctx: AiCompileContext,
    config: Readonly<AiConfig>,
  ) => TransportRuleAppender[];
};

function ensureFetchStream(cfg: ChaosConfig): FetchStreamConfig {
  return (cfg.fetchStream ??= {});
}
function ensureSse(cfg: ChaosConfig): SSEConfig {
  return (cfg.sse ??= {});
}
function ensureWebsocket(cfg: ChaosConfig): WebSocketConfig {
  return (cfg.websocket ??= {});
}

const FIRST_CHUNK_DELAY: AiTranslation<'firstChunkDelayMs'> = {
  aiField: 'firstChunkDelayMs',
  description: 'Delay the first chunk of a matched streaming response.',
  compile: (ms, ctx) => {
    const out: TransportRuleAppender[] = [];
    if (ctx.transports.includes('fetch-stream')) {
      out.push({
        apply: (cfg) => {
          const fs = ensureFetchStream(cfg);
          (fs.delays ??= []).push({
            urlPattern: ctx.urlPattern,
            chunkIndex: 0,
            delayMs: ms,
            probability: 1,
          });
        },
      });
    }
    if (ctx.transports.includes('sse')) {
      out.push({
        apply: (cfg) => {
          const sse = ensureSse(cfg);
          (sse.delays ??= []).push({
            urlPattern: ctx.urlPattern,
            delayMs: ms,
            probability: 1,
            onNth: 1,
          });
        },
      });
    }
    if (ctx.transports.includes('websocket')) {
      out.push({
        apply: (cfg) => {
          const ws = ensureWebsocket(cfg);
          (ws.delays ??= []).push({
            urlPattern: ctx.urlPattern,
            direction: 'inbound',
            delayMs: ms,
            probability: 1,
            onNth: 1,
          });
        },
      });
    }
    return out;
  },
};

const PAUSE_AFTER_CHUNK: AiTranslation<'pauseAfterChunk'> = {
  aiField: 'pauseAfterChunk',
  description: 'Pause the stream after the Kth chunk for pauseDurationMs.',
  compile: (k, ctx, config) => {
    const ms = config.pauseDurationMs ?? 0;
    if (ms <= 0) return []; // schema guarantees the pair, but defend against direct callers
    const out: TransportRuleAppender[] = [];
    if (ctx.transports.includes('fetch-stream')) {
      out.push({
        apply: (cfg) => {
          const fs = ensureFetchStream(cfg);
          (fs.delays ??= []).push({
            urlPattern: ctx.urlPattern,
            chunkIndex: k,
            delayMs: ms,
            probability: 1,
          });
        },
      });
    }
    if (ctx.transports.includes('sse')) {
      out.push({
        apply: (cfg) => {
          const sse = ensureSse(cfg);
          (sse.delays ??= []).push({
            urlPattern: ctx.urlPattern,
            delayMs: ms,
            probability: 1,
            onNth: k + 1,
          });
        },
      });
    }
    if (ctx.transports.includes('websocket')) {
      out.push({
        apply: (cfg) => {
          const ws = ensureWebsocket(cfg);
          (ws.delays ??= []).push({
            urlPattern: ctx.urlPattern,
            direction: 'inbound',
            delayMs: ms,
            probability: 1,
            onNth: k + 1,
          });
        },
      });
    }
    return out;
  },
};

const PAUSE_DURATION: AiTranslation<'pauseDurationMs'> = {
  aiField: 'pauseDurationMs',
  description: 'Companion to pauseAfterChunk; the pause length is read by the pauseAfterChunk row.',
  compile: () => [], // consumed by PAUSE_AFTER_CHUNK
};

const TRUNCATE_AFTER_CHUNK: AiTranslation<'truncateAfterChunk'> = {
  aiField: 'truncateAfterChunk',
  description: 'Close the stream after the Kth chunk.',
  compile: (k, ctx) => {
    const out: TransportRuleAppender[] = [];
    if (ctx.transports.includes('fetch-stream')) {
      out.push({
        apply: (cfg) => {
          const fs = ensureFetchStream(cfg);
          (fs.closes ??= []).push({
            urlPattern: ctx.urlPattern,
            afterChunk: k,
            probability: 1,
          });
        },
      });
    }
    // sse + ws close rules use afterMs only; no after-N-message shape exists.
    // Compiler skips them silently for this AI field per the module-level
    // coverage notes above.
    return out;
  },
};

const DUPLICATE_CHUNK_PROBABILITY: AiTranslation<'duplicateChunkProbability'> = {
  aiField: 'duplicateChunkProbability',
  description: 'Duplicate streaming chunks with the given probability.',
  compile: (p, ctx) => {
    const out: TransportRuleAppender[] = [];
    if (ctx.transports.includes('fetch-stream')) {
      out.push({
        apply: (cfg) => {
          const fs = ensureFetchStream(cfg);
          (fs.corruptions ??= []).push({
            urlPattern: ctx.urlPattern,
            strategy: 'duplicate',
            probability: p,
          });
        },
      });
    }
    // sse + ws corruption strategies do not include 'duplicate' today.
    // Compiler skips them silently.
    return out;
  },
};

const RECONNECT_AFTER_DROP: AiTranslation<'reconnectAfterDrop'> = {
  aiField: 'reconnectAfterDrop',
  description: 'Passive flag; consumed by future drop-rule annotation.',
  compile: () => [], // honored via AiCompileContext.reconnectAfterDrop
};

const TRANSPORT_TRANSLATION: AiTranslation<'transport'> = {
  aiField: 'transport',
  description: 'Resolved into AiCompileContext.transports before compilation; emits nothing.',
  compile: () => [],
};

/**
 * Declarative translation table. The compiler iterates this array in order;
 * reviewers diff entries here rather than branching `if` ladders. Order is
 * stable and matches the ordering of fields on `AiConfig` so reading the
 * type and reading the table align.
 *
 * KEEP IN LOCKSTEP with `AiConfig`: a new field on the interface MUST add a
 * row here (drift test enforces).
 */
export const AI_TRANSLATIONS: ReadonlyArray<AnyAiTranslation> = [
  FIRST_CHUNK_DELAY,
  PAUSE_AFTER_CHUNK,
  PAUSE_DURATION,
  TRUNCATE_AFTER_CHUNK,
  DUPLICATE_CHUNK_PROBABILITY,
  RECONNECT_AFTER_DROP,
  TRANSPORT_TRANSLATION,
] as unknown as ReadonlyArray<AnyAiTranslation>;

const ALL_STREAMING_TRANSPORTS: ReadonlyArray<Exclude<AiTransport, 'auto'>> = ['fetch-stream', 'sse', 'websocket'];

function resolveTransports(transport: AiTransport | undefined): ReadonlyArray<Exclude<AiTransport, 'auto'>> {
  if (transport === undefined || transport === 'auto') return ALL_STREAMING_TRANSPORTS;
  return [transport];
}

/**
 * Compile a `config.ai` slice into transport rule arrays appended onto the
 * SAME `config` reference (mutating). Returns the config for chaining.
 * Removes `config.ai` after compilation so the runtime never sees it.
 *
 * Resolution slot inside `prepareChaosConfig`: AFTER preset expansion (so AI
 * rules append onto the already-merged transport buckets) and BEFORE matcher
 * resolution (so `'*'` urlPatterns flow through the standard pipeline).
 */
export function compileAiToRules(config: ChaosConfig): ChaosConfig {
  const ai = config.ai;
  if (!ai) return config;

  const ctx: AiCompileContext = {
    transports: resolveTransports(ai.transport),
    reconnectAfterDrop: ai.reconnectAfterDrop ?? false,
    urlPattern: '*',
  };

  for (const translation of AI_TRANSLATIONS) {
    const value = ai[translation.aiField];
    if (value === undefined || value === null) continue;
    const appenders = translation.compile(value, ctx, ai);
    for (const appender of appenders) appender.apply(config);
  }

  delete config.ai;
  return config;
}
