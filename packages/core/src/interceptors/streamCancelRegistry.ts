/** Shared registry of in-flight streaming connections that the
 *  user-interaction cancel trigger can abort. Transport interceptors register
 *  every connection they wrap; the trigger calls `cancelAll()` once at its
 *  scheduled time.
 *
 *  Registrations are never removed on natural completion: cancelling an
 *  already-finished connection is a no-op at the transport layer (aborting a
 *  fully-consumed fetch does nothing; closed SSE/WS report `CLOSED` and are
 *  skipped via the `cancel()` return value), so the registry trades a bounded
 *  amount of per-connection memory for zero completion-tracking races. The
 *  set is cleared on `cancelAll()` and on engine stop. */

export type CancelableTransport = 'fetch-stream' | 'sse' | 'websocket';

export interface CancelableStreamConnection {
  transport: CancelableTransport;
  url: string;
  /** Stable per-connection id when the transport minted one. Mutable because
   *  fetch-stream mints ids only for rule-matched responses, after the
   *  connection is already registered. */
  connectionId?: string;
  /** Best-effort cancel. Must be idempotent and safe on closed connections.
   *  Returns true when the cancel actually applied (the connection was still
   *  live), false when there was nothing left to cancel. */
  cancel(): boolean;
}

export class StreamCancelRegistry {
  private active = new Set<CancelableStreamConnection>();

  register(connection: CancelableStreamConnection): void {
    this.active.add(connection);
  }

  /** Cancel every registered connection and clear the registry. Returns the
   *  connections whose `cancel()` reported actually applying, in registration
   *  order, so the caller can emit one event per cancelled connection. */
  cancelAll(): CancelableStreamConnection[] {
    const cancelled: CancelableStreamConnection[] = [];
    for (const connection of this.active) {
      let applied = false;
      try {
        applied = connection.cancel();
      } catch {
        // Best-effort: a throwing transport close must not break the sweep.
      }
      if (applied) cancelled.push(connection);
    }
    this.active.clear();
    return cancelled;
  }

  clear(): void {
    this.active.clear();
  }
}
