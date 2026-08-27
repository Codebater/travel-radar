/**
 * §8 - the notification channel contract.
 *
 * One channel is real in Phase 7 (ntfy). The abstraction exists so that adding
 * a second one later is a new file rather than a refactor of the delivery
 * logic - and so that the dry-run and the tests can substitute a channel that
 * cannot reach the network at all.
 *
 * Two rules the contract enforces on every implementation:
 *
 *   - `send` NEVER throws. A channel that is down is a delivery outcome, not an
 *     exception: this code runs inside the scheduler tick, and an unhandled
 *     rejection there would take down the observation collection that is the
 *     valuable half of this system (§40).
 *   - nothing that identifies the destination - server, topic, token - may
 *     appear in any field of the result. The result is written to the database
 *     and rendered in a read-only web page (§9/§39).
 */

/** What a channel is asked to deliver. Already rendered; no candidate objects. */
export interface NotificationMessage {
  /** Short line shown as the notification title. */
  title: string
  /** The body. Plain text, already formatted for a phone screen. */
  body: string
  /** 1 (min) .. 5 (max). Only an extreme-bypass alert should ever ask for 5. */
  priority: 1 | 2 | 3 | 4 | 5
  /** Short labels, e.g. ["fire", "airplane"]. */
  tags: string[]
  /** Where tapping the notification goes. Built from the configured base URL only. */
  clickUrl: string | null
}

export interface DeliveryResult {
  ok: boolean
  /** Provider-side identifier when one is returned, for the audit trail. */
  reference: string | null
  /** HTTP status when the attempt reached a server at all. */
  status: number | null
  latencyMs: number
  /**
   * Why it failed, safe to store and display. Implementations must scrub the
   * destination out of upstream error text before it lands here.
   */
  error: string | null
  /** False when the failure is permanent and retrying cannot help (e.g. 400). */
  retryable: boolean
}

export interface ChannelHealth {
  channel: string
  /** ok = configured and usable; unconfigured = no secret; error = misconfigured. */
  status: "ok" | "unconfigured" | "error"
  /** Human detail. Must never contain the topic or token. */
  detail: string
  checkedAt: string
}

export interface NotificationChannel {
  readonly name: string
  /** Are the secrets present? Never reveals what they are. */
  isConfigured(): boolean
  /** Configuration check only - performs no network request and sends nothing. */
  health(): ChannelHealth
  /** Deliver one message. Must never throw. */
  send(message: NotificationMessage): Promise<DeliveryResult>
}

/**
 * Strip everything that could break out of the transport or the screen.
 *
 * ntfy carries the title, tags and click URL in HTTP HEADERS when the plain
 * publishing form is used, so a candidate field containing CR or LF would
 * inject a header - and candidate fields carry provider and airline names that
 * this project does not author. The JSON publishing form (which this channel
 * uses) removes that class of bug structurally; this function is the second
 * layer, and it also keeps a stray control character from mangling the phone's
 * notification shade.
 */
export function scrub(value: string, maxLength = 200): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
}

/**
 * The same idea for a multi-line body: newlines are the formatting, so they
 * survive, and every other control character does not. Using `scrub` here
 * would collapse the message into one unreadable line - which is exactly what
 * happened the first time.
 */
export function scrubBody(value: string, maxLength = 1200): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength)
}
