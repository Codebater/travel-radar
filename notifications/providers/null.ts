/**
 * The channel that cannot send.
 *
 * Used by `notify:dry-run` and by every test. It is not a stub for
 * convenience: it is how "this run cannot possibly deliver anything" is made
 * true structurally rather than promised in a comment.
 *
 * Note what it does NOT do: it never reads NTFY_TOPIC, NTFY_TOKEN or
 * NTFY_SERVER. A dry run cannot leak the destination because it never learns
 * it, which is a stronger guarantee than remembering to redact the output.
 */

import type {
  ChannelHealth, DeliveryResult, NotificationChannel, NotificationMessage,
} from "./types.js"

export class NullChannel implements NotificationChannel {
  readonly name = "null"
  /** Everything it was asked to deliver, in order, for assertions and dry-run output. */
  readonly sent: NotificationMessage[] = []

  isConfigured(): boolean {
    return true
  }

  health(): ChannelHealth {
    return {
      channel: this.name,
      status: "ok",
      detail: "dry run - nothing can be delivered and no destination is read",
      checkedAt: new Date().toISOString(),
    }
  }

  async send(message: NotificationMessage): Promise<DeliveryResult> {
    this.sent.push(message)
    return { ok: true, reference: "dry-run", status: null, latencyMs: 0, error: null, retryable: false }
  }
}

/**
 * A channel that always fails, for the retry and isolation tests. `retryable`
 * is settable because "the server is down" and "the token is revoked" must
 * take different paths through the state machine.
 */
export class FailingChannel implements NotificationChannel {
  readonly name = "failing"
  attempts = 0

  constructor(
    private readonly detail = "connection refused",
    private readonly retryable = true,
    private readonly status: number | null = null,
  ) {}

  isConfigured(): boolean { return true }

  health(): ChannelHealth {
    return {
      channel: this.name, status: "ok", detail: "test double that always fails",
      checkedAt: new Date().toISOString(),
    }
  }

  async send(): Promise<DeliveryResult> {
    this.attempts++
    return {
      ok: false, reference: null, status: this.status, latencyMs: 1,
      error: this.detail, retryable: this.retryable,
    }
  }
}
