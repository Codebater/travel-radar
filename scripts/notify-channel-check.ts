#!/usr/bin/env tsx
/**
 * §11/§39/§48 - prove the ntfy channel works end to end, with real HTTP, without
 * publishing anything to anybody.
 *
 * The channel deliberately accepts a loopback server, so this stands up a
 * throwaway one that speaks ntfy's JSON publishing API and points the channel
 * at it. That exercises the genuine path - real socket, real JSON body, real
 * Authorization header, real response parsing - while the operator's actual
 * topic stays unset and no data leaves the machine.
 *
 * It also asserts the two security properties that cannot be checked from
 * inside the channel: that exactly two header names are sent (every ntfy
 * example on the internet puts the title and tags in HTTP headers, at which
 * point an airline name becomes a header value), and that a candidate field
 * carrying a carriage return cannot break out of the body.
 */

import http from "http"
import "../load-env.js"
import { NtfyChannel } from "../notifications/providers/ntfy.js"
import { renderTest } from "../notifications/format.js"

interface Received {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

async function main() {
  const received: Received[] = []
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", chunk => { body += chunk })
    req.on("end", () => {
      received.push({ method: req.method || "", url: req.url || "", headers: req.headers, body })
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ id: "loopback-message-1", time: Math.floor(Date.now() / 1000) }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port

  process.env.NTFY_SERVER = `http://127.0.0.1:${port}`
  process.env.NTFY_TOPIC = "loopback-check-topic"
  process.env.NTFY_TOKEN = "tk_loopbackcheck0000"

  const channel = new NtfyChannel()
  const health = channel.health()
  console.log(`health: ${health.status} — ${health.detail}`)
  if (health.detail.includes("loopback-check-topic")) {
    console.log("❌ the health line names the topic")
    process.exitCode = 1
  }

  // 1. The real test message.
  const test = await channel.send(renderTest())
  console.log(
    `test message: ok=${test.ok} status=${test.status} ${test.latencyMs}ms ` +
    `reference=${test.reference}`,
  )

  // 2. A message carrying the nastiest thing a provider could put in a field.
  const hostile = await channel.send({
    title: "Air\r\nX-Priority: 5",
    body: "VIE -> BKK\r\nX-Click: https://evil.example\nreal second line",
    priority: 4,
    tags: ["fire\r\nX-Tags: bomb"],
    clickUrl: "http://127.0.0.1:8888/deals.html#candidate=1",
  })
  console.log(`hostile message: ok=${hostile.ok} status=${hostile.status}`)

  server.close()

  console.log(`\nrequests received: ${received.length}`)
  let failures = 0
  for (const [index, request] of received.entries()) {
    const headerNames = Object.keys(request.headers)
      .filter(h => !["host", "connection", "content-length", "accept", "accept-encoding",
                     "accept-language", "user-agent", "sec-fetch-mode"].includes(h))
      .sort()
    const parsed = JSON.parse(request.body)
    console.log(`\n[${index}] ${request.method} ${request.url}`)
    console.log(`    header names: ${headerNames.join(", ")}`)
    console.log(`    topic: ${parsed.topic}`)
    console.log(`    title: ${JSON.stringify(parsed.title)}`)
    console.log(`    message: ${JSON.stringify(parsed.message).slice(0, 160)}`)
    console.log(`    priority: ${parsed.priority}  tags: ${JSON.stringify(parsed.tags)}`)
    console.log(`    click: ${parsed.click ?? "(none)"}`)

    // The publish must go to the ORIGIN, never to /topic - the path form is
    // ntfy's plain API, where the body becomes the message text.
    if (request.url !== "/") { console.log("    ❌ published to a path rather than the origin"); failures++ }
    // Exactly two header names may carry anything of ours.
    const unexpected = headerNames.filter(h => h !== "content-type" && h !== "authorization")
    if (unexpected.length) { console.log(`    ❌ unexpected headers: ${unexpected.join(", ")}`); failures++ }
    if (/[\r\n]/.test(parsed.title)) { console.log("    ❌ CR/LF survived into the title"); failures++ }
    for (const tag of parsed.tags ?? []) {
      if (/[\r\n]/.test(tag)) { console.log("    ❌ CR/LF survived into a tag"); failures++ }
    }
    if (/\r/.test(parsed.message)) { console.log("    ❌ a carriage return survived into the body"); failures++ }
    if (String(request.headers.authorization ?? "") !== "Bearer tk_loopbackcheck0000") {
      console.log("    ❌ the bearer token was not sent as expected"); failures++
    }
  }

  console.log(failures === 0
    ? "\n✅ channel verified end to end: right target, two headers, nothing injectable."
    : `\n❌ ${failures} channel check(s) failed.`)
  if (failures > 0) process.exitCode = 1
}

main().catch(err => {
  console.error("❌", (err as Error).message)
  process.exit(1)
})
