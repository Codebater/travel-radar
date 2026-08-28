/**
 * URL safety for offer navigation.
 *
 * Lessons already paid for in this repo (Phase 7 deepLinkFor): string
 * concatenation onto an origin is not safe — a crafted path can change the
 * host. So every URL that will ever be rendered as a navigation target is
 * PARSED, then ASSERTED: https only, exact-host allowlist per provider, no
 * embedded credentials. A URL that fails is dropped — the locator degrades to
 * the next honest quality — never repaired, never rendered.
 */

import { allowedDomainsFor } from "./config.js"

/** Parse + assert. Returns the normalized href, or null when unsafe. */
export function safeProviderUrl(provider: string, url: string | null | undefined): string | null {
  if (typeof url !== "string" || !url.trim()) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== "https:") return null
  if (parsed.username || parsed.password) return null
  const allowed = allowedDomainsFor(provider)
  if (!allowed.includes(parsed.hostname)) return null
  return parsed.href
}

/**
 * Resolve a provider-returned RELATIVE path against the provider's own
 * origin, then run the same assertion — the resolved host must still be the
 * provider's. Absolute inputs are passed through the assertion unchanged, so
 * a "relative" value that smuggles in a host ("//evil.example/x",
 * "https://evil.example/x", "@evil.example/x") comes back null.
 */
export function resolveProviderPath(provider: string, origin: string, path: string | null | undefined): string | null {
  if (typeof path !== "string" || !path.trim()) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) {
    // Absolute (or scheme-relative): no resolution, assertion only.
    return safeProviderUrl(provider, path.startsWith("//") ? `https:${path}` : path)
  }
  let resolved: URL
  try {
    resolved = new URL(path, origin)
  } catch {
    return null
  }
  return safeProviderUrl(provider, resolved.href)
}

/** Build a query URL from parts with URLSearchParams doing ALL the encoding. */
export function buildQueryUrl(base: string, params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value))
  }
  const qs = search.toString()
  return qs ? `${base}?${qs}` : base
}

/** A path segment from free text (hotel names): ASCII slug, never URL-active. */
export function slugSegment(text: string | null | undefined, fallback: string): string {
  const slug = (text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || fallback
}
