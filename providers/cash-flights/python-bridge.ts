/**
 * Spawning the Python helper scripts.
 *
 * execFileSync with an argv array, never a shell string — route and date values
 * reach here from HTTP query parameters and must never be able to become shell
 * syntax. This is the Phase 1 command-injection fix; keep it that way.
 */

import fs from "fs"
import path from "path"
import { execFile, execFileSync } from "child_process"
import { promisify } from "util"
import { fileURLToPath } from "url"

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))

let resolved: string | null = null

/**
 * Resolve the Python interpreter: project venv (POSIX and Windows layouts)
 * first, then whichever of python/python3 actually exists on PATH.
 */
export function resolvePython(): string {
  if (resolved) return resolved

  const candidates = [
    path.join(ROOT, ".venv", "bin", "python3"),
    path.join(ROOT, ".venv", "Scripts", "python.exe"),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return (resolved = c)
  }
  for (const bin of process.platform === "win32" ? ["python", "python3"] : ["python3", "python"]) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 10_000 })
      return (resolved = bin)
    } catch { /* try the next candidate */ }
  }
  return (resolved = process.platform === "win32" ? "python" : "python3")
}

/** Only for tests, so a stubbed interpreter can be swapped in. */
export function resetPythonCache(): void {
  resolved = null
}

export interface PythonRunResult<T> {
  ok: boolean
  data: T | null
  error?: string
}

const execFileAsync = promisify(execFile)

function spawnOptions(timeoutMs: number) {
  return {
    timeout: timeoutMs,
    encoding: "utf-8" as const,
    maxBuffer: 16 * 1024 * 1024,
    // Force UTF-8 so airline and city names survive Windows' default codepage.
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
  }
}

/** Scripts log to stderr, so only the last stdout line carries the payload. */
function parseLastLine<T>(stdout: string): PythonRunResult<T> {
  const lines = String(stdout).trim().split("\n")
  const last = lines[lines.length - 1]
  if (!last) return { ok: false, data: null, error: "helper produced no output" }
  try {
    return { ok: true, data: JSON.parse(last) as T }
  } catch (err) {
    return { ok: false, data: null, error: `helper output was not JSON: ${(err as Error).message}` }
  }
}

function describeError(err: unknown, timeoutMs: number): string {
  const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string; signal?: string; killed?: boolean }
  if (e.signal === "SIGTERM" || e.killed) return `helper timed out after ${timeoutMs}ms`
  const stderr = e.stderr ? String(e.stderr).trim().split("\n").slice(-3).join(" | ") : ""
  return `${e.message?.slice(0, 160)}${stderr ? ` — ${stderr.slice(0, 240)}` : ""}`
}

/**
 * Run a helper script and parse the JSON object it writes to stdout.
 *
 * Asynchronous on purpose. execFileSync blocks the entire Node event loop for
 * the lifetime of the child process, which made the HTTP server handle exactly
 * one request at a time and defeated the server's duplicate-request collapsing.
 */
export async function runPythonJson<T>(
  scriptRelPath: string,
  argv: string[],
  timeoutMs: number,
): Promise<PythonRunResult<T>> {
  const scriptPath = path.join(ROOT, scriptRelPath)
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, data: null, error: `helper script not found: ${scriptRelPath}` }
  }

  try {
    const { stdout } = await execFileAsync(resolvePython(), [scriptPath, ...argv], spawnOptions(timeoutMs))
    return parseLastLine<T>(stdout)
  } catch (err) {
    return { ok: false, data: null, error: describeError(err, timeoutMs) }
  }
}

/**
 * Synchronous variant for the few callers that are not inside an async flow.
 * Prefer runPythonJson — this one blocks the event loop.
 */
export function runPythonJsonSync<T>(
  scriptRelPath: string,
  argv: string[],
  timeoutMs: number,
): PythonRunResult<T> {
  const scriptPath = path.join(ROOT, scriptRelPath)
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, data: null, error: `helper script not found: ${scriptRelPath}` }
  }

  try {
    const stdout = execFileSync(resolvePython(), [scriptPath, ...argv], {
      ...spawnOptions(timeoutMs),
      stdio: ["ignore", "pipe", "pipe"],
    })
    return parseLastLine<T>(stdout)
  } catch (err) {
    return { ok: false, data: null, error: describeError(err, timeoutMs) }
  }
}
