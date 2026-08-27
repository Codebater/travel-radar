/**
 * §8/§9 - the one real channel in Phase 7.
 *
 * Three decisions worth stating, because all three are security decisions
 * dressed as implementation details:
 *
 * 1. It publishes with ntfy's JSON form (the topic in a JSON body) rather than
 *    the plain form (POST /topic, with the title, tags and click URL in HTTP
 *    HEADERS). The plain form is what every ntfy example on the internet uses -
 *    and it means a candidate field containing a carriage return injects an
 *    HTTP header. This project does not author the strings in a notification:
 *    airline names, provider names and route codes come from upstream vendors.
 *    JSON publishing makes that class of bug structurally impossible rather
 *    than relying on us to remember to sanitise. `scrub` is still applied, as
 *    the second layer.
 *
 * 2. The destination is validated in `readConfig`, not in `health`. Validating
 *    only in `health` produces the worst possible outcome: `notify:status`
 *    prints "error" while the dispatcher cheerfully sends anyway. A
 *    destination that cannot be vouched for is UNCONFIGURED - the channel
 *    refuses rather than downgrading.
 *
 *    Two specific rejections earn their lines:
 *      - plain http to a non-loopback host would put `Authorization: Bearer
 *        <token>` and the deal body on the wire in the clear;
 *      - a PATH on the server URL. `POST https://ntfy.sh/travel` is ntfy's
 *        *plain* publishing form, where the body becomes the message text - so
 *        a server of "https://ntfy.sh/travel" would post a JSON document
 *        containing the real, private topic into a topic somebody else chose.
 *
 * 3. Every error string leaves through `redactSecrets`. `fetch` failures name
 *    the host, and often the topic, and this text is stored and rendered.
 *
 * The channel never throws. It runs inside the scheduler tick, and an unhandled
 * rejection there would take down the observation collection that is the more
 * valuable half of this system (§40).
 */

import { redactSecrets } from "../redact.js"
import {
  scrub, scrubBody,
  type ChannelHealth, type DeliveryResult, type NotificationChannel, type NotificationMessage,
} from "./types.js"

const DEFAULT_SERVER = "https://ntfy.sh"
const TIMEOUT_MS = 8_000

export interface NtfyConfig {
  /** The ORIGIN to post to. Never carries a path, query or fragment. */
  origin: string
  host: string
  topic: string
  token: string | null
}

export type ConfigProblem =
  | { ok: false; reason: "unconfigured"; detail: string }
  | { ok: false; reason: "invalid"; detail: string }

export type ConfigResult = { ok: true; config: NtfyConfig } | ConfigProblem

/**
 * Read and VALIDATE the destination. The only place either happens.
 */
export function readNtfyConfig(): ConfigResult {
  const topic = (process.env.NTFY_TOPIC || "").trim()
  if (!topic) {
    return {
      ok: false, reason: "unconfigured",
      detail: "NTFY_TOPIC is not set - add it to .env (never to a config file in git)",
    }
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) {
    return {
      ok: false, reason: "invalid",
      detail: "NTFY_TOPIC must be 1-64 characters of letters, digits, underscore or hyphen",
    }
  }

  const raw = (process.env.NTFY_SERVER || DEFAULT_SERVER).trim()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: "invalid", detail: "NTFY_SERVER is not a valid URL" }
  }

  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  if (url.protocol !== "https:" && !loopback) {
    return {
      ok: false, reason: "invalid",
      detail: `NTFY_SERVER must be https (or a loopback address for testing) - ` +
        `${url.protocol}// would send the token and the deal in the clear`,
    }
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    return {
      ok: false, reason: "invalid",
      detail: "NTFY_SERVER must be a bare origin with no path, query or fragment - " +
        "a path turns this into ntfy's plain publishing form and would post the private topic " +
        "as message text into whatever topic the path names",
    }
  }

  const token = (process.env.NTFY_TOKEN || "").trim() || null
  if (token && !/^[A-Za-z0-9._~+/-]{8,512}=*$/.test(token)) {
    return { ok: false, reason: "invalid", detail: "NTFY_TOKEN contains characters a bearer token cannot contain" }
  }

  return { ok: true, config: { origin: url.origin, host: url.host, topic, token } }
}

/** Is this status worth trying again, or is the request itself wrong? */
export function isRetryable(status: number): boolean {
  // 429 and 5xx are transient. Any other 4xx means the request or the
  // credentials are wrong, and three attempts change nothing except how long
  // the operator waits to find out.
  return status === 429 || status >= 500
}

export class NtfyChannel implements NotificationChannel {
  readonly name = "ntfy"

  isConfigured(): boolean {
    return readNtfyConfig().ok
  }

  health(): ChannelHealth {
    const checkedAt = new Date().toISOString()
    const result = readNtfyConfig()
    if (!result.ok) {
      return {
        channel: this.name,
        status: result.reason === "unconfigured" ? "unconfigured" : "error",
        detail: result.detail,
        checkedAt,
      }
    }
    // The HOST is named because knowing whether you are pointed at ntfy.sh or
    // your own server is operationally useful. The TOPIC never is: on public
    // ntfy it is the entire access control.
    return {
      channel: this.name, status: "ok", checkedAt,
      detail: `configured for ${result.config.host}, topic hidden` +
        `${result.config.token ? ", token present" : ", no token"}`,
    }
  }

  async send(message: NotificationMessage): Promise<DeliveryResult> {
    const started = Date.now()
    const result = readNtfyConfig()
    if (!result.ok) {
      return {
        ok: false, reference: null, status: null, latencyMs: 0,
        error: result.detail,
        // A misconfiguration is not a transient failure. Retrying an https
        // rule three times does not make it https.
        retryable: false,
      }
    }
    const config = result.config

    // Scrubbed even though a JSON body cannot inject a header: the phone still
    // renders this, and a candidate carrying 400 characters of provider error
    // text is not a notification anybody can read.
    const payload: Record<string, unknown> = {
      topic: config.topic,
      title: scrub(message.title, 120),
      // scrubBody, not scrub: the body's newlines ARE its formatting, and the
      // single-line scrubber collapses a carefully laid out alert into one
      // run-on sentence. The loopback check caught this by printing what
      // actually arrived rather than what was intended.
      message: scrubBody(message.body, 1200),
      priority: Math.max(1, Math.min(5, message.priority)),
      tags: message.tags.map(t => scrub(t, 24)).filter(Boolean).slice(0, 5),
    }
    // A click URL is only ever built from the configured base URL, never from a
    // candidate field - but it is re-validated here too, because this is the
    // last place before it leaves the process.
    if (message.clickUrl) {
      try {
        const link = new URL(message.clickUrl)
        if (link.protocol === "http:" || link.protocol === "https:") payload.click = link.toString()
      } catch { /* a malformed link is dropped, not sent */ }
    }

    // Exactly two possible header keys, asserted by construction. Every ntfy
    // example uses X-Title / X-Tags / X-Priority / X-Click; the moment one of
    // those appears here, a route or airline string becomes a header value.
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (config.token) headers.Authorization = `Bearer ${config.token}`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const response = await fetch(config.origin, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        // A redirect would re-send the Authorization header to wherever the
        // redirect points, which is a token-exfiltration primitive.
        redirect: "error",
        signal: controller.signal,
      })
      const latencyMs = Date.now() - started

      if (!response.ok) {
        let detail = ""
        try { detail = (await response.text()).slice(0, 200) } catch { /* body is optional */ }
        return {
          ok: false, reference: null, status: response.status, latencyMs,
          error: redactSecrets(`ntfy returned ${response.status} ${response.statusText} ${detail}`.trim()),
          retryable: isRetryable(response.status),
        }
      }

      // ntfy answers a successful publish with the message object it stored.
      let reference: string | null = null
      try {
        const body = await response.json() as { id?: string }
        if (typeof body?.id === "string") reference = scrub(body.id, 64)
      } catch { /* a publish without a parseable body still succeeded */ }

      return { ok: true, reference, status: response.status, latencyMs, error: null, retryable: false }
    } catch (err) {
      const aborted = (err as Error).name === "AbortError"
      return {
        ok: false, reference: null, status: null, latencyMs: Date.now() - started,
        error: redactSecrets(aborted ? `no response within ${TIMEOUT_MS / 1000}s` : (err as Error).message),
        retryable: true,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
