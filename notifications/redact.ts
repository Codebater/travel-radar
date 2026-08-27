/**
 * §9/§39 - the destination never leaves this process in readable form.
 *
 * This lives here rather than in the ntfy channel because it is a WRITE-PATH
 * rule, not a channel rule. The channel is not the only thing that handles an
 * error string containing the publish URL: the dispatcher logs, the queue
 * records `last_error`, the CLI prints, and /alerts.html renders. Any one of
 * those forgetting is a leak, so the scrubbing sits where all of them can
 * reach it and every write goes through it unconditionally.
 *
 * The specific failure this prevents: a `fetch` rejection reads
 * "connect ECONNREFUSED ntfy.example.com:443" and a `console.warn` in a catch
 * block - copied from the idiom the scheduler already uses everywhere - puts
 * the host, and often the topic, on stdout and into whatever collects it. On
 * public ntfy the topic is the entire access control.
 */

import { scrub } from "./providers/types.js"

/**
 * Remove anything that identifies the notification destination.
 *
 * Two layers on purpose. The first removes the CONFIGURED values, which is
 * exact. The second removes anything shaped like a URL or a bearer token,
 * which catches a value that arrived from somewhere this function was never
 * told about - a redirect target, a proxy error, a second server in a chained
 * message. Being over-aggressive here costs a slightly vaguer error message;
 * being under-aggressive costs the topic.
 */
export function redactSecrets(text: string): string {
  if (!text) return ""
  let out = String(text)

  for (const name of ["NTFY_TOPIC", "NTFY_TOKEN", "NTFY_SERVER"] as const) {
    const value = (process.env[name] || "").trim()
    // A one- or two-character value would match half the alphabet; a real
    // topic or token is never that short, and a bad one is not worth
    // corrupting every message to hide.
    if (value.length >= 4) {
      out = out.split(value).join(`<${name.replace("NTFY_", "").toLowerCase()}>`)
    }
  }

  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer <token>")
  out = out.replace(/tk_[A-Za-z0-9]+/g, "<token>")
  out = out.replace(/https?:\/\/[^\s"')]+/gi, "<url>")
  return scrub(out, 300)
}

/**
 * True when `text` still contains a configured secret.
 *
 * Used by the security regression tests, which is the point: a test that scans
 * for the canary itself would duplicate the knowledge of which variables
 * matter, and drift from it the day a fourth one is added.
 */
export function containsSecret(text: string): boolean {
  if (!text) return false
  for (const name of ["NTFY_TOPIC", "NTFY_TOKEN", "NTFY_SERVER"] as const) {
    const value = (process.env[name] || "").trim()
    if (value.length >= 4 && text.includes(value)) return true
  }
  return false
}
