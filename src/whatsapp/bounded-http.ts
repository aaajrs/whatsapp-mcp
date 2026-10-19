// Bounds encrypted HTTP bytes before the Rust bridge copies/decrypts them.
export interface HttpReply {
  statusCode: number
  body: Uint8Array
}
export type HttpExecute = (
  url: string,
  method: string,
  headers: Record<string, string>,
  body: Uint8Array | null,
) => Promise<HttpReply>
export interface BoundedScope {
  matches(url: string): boolean
  execute: HttpExecute
  close(): void
}
export function createBoundedScope(
  directPath: string,
  maxBytes: number,
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
): BoundedScope {
  if (
    !directPath.startsWith("/") ||
    directPath.startsWith("//") ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 5 * 1024 * 1024 + 26 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 30_000
  )
    throw new Error("INVALID_MEDIA_LIMITS")
  const path = new URL(directPath, "https://media.invalid").pathname
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  let consumed = 0
  let requests = 0
  let busy = false
  const close = () => {
    clearTimeout(timeout)
    controller.abort()
  }
  const matches = (url: string) => {
    try {
      return new URL(url).pathname === path
    } catch {
      return false
    }
  }
  const execute: HttpExecute = async (url, method, headers, body) => {
    if (controller.signal.aborted) throw new Error("MEDIA_ABORTED")
    if (
      !matches(url) ||
      new URL(url).protocol !== "https:" ||
      new URL(url).hostname !== "mmg.whatsapp.net" ||
      new URL(url).port !== "" ||
      new URL(url).username !== "" ||
      new URL(url).password !== "" ||
      method !== "GET" ||
      body !== null ||
      busy ||
      ++requests > 3
    ) {
      close()
      throw new Error("MEDIA_REQUEST_REJECTED")
    }
    busy = true
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await fetcher(url, {
        method,
        headers,
        signal: controller.signal,
        redirect: "error",
      })
      const declared = response.headers.get("content-length")
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes))
        throw new Error("MEDIA_HTTP_SIZE_LIMIT")
      if (!response.body) return { statusCode: response.status, body: new Uint8Array() }
      reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let length = 0
      for (;;) {
        if (controller.signal.aborted) throw new Error("MEDIA_ABORTED")
        const next = await reader.read()
        if (next.done) break
        length += next.value.byteLength
        consumed += next.value.byteLength
        if (length > maxBytes || consumed > maxBytes * 2) throw new Error("MEDIA_HTTP_SIZE_LIMIT")
        chunks.push(next.value)
      }
      const result = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.byteLength
      }
      return { statusCode: response.status, body: result }
    } catch {
      close() // Abort the actual fetch; not merely the promise waiting for it.
      if (reader) {
        try {
          await reader.cancel()
        } catch {
          /* transport already aborted */
        }
      }
      throw new Error("MEDIA_HTTP_FAILED")
    } finally {
      reader?.releaseLock()
      busy = false
    }
  }
  return { matches, execute, close }
}

// One router per socket/account. Unrelated sync requests keep the original callback.
export function createMediaHttpRouter(fetcher: typeof fetch = fetch) {
  let scope: BoundedScope | null = null
  return {
    wrap(original: HttpExecute): HttpExecute {
      return (url, method, headers, body) =>
        scope?.matches(url)
          ? scope.execute(url, method, headers, body)
          : original(url, method, headers, body)
    },
    async run<T>(directPath: string, maxBytes: number, operation: () => Promise<T>): Promise<T> {
      if (scope) throw new Error("MEDIA_BUSY")
      scope = createBoundedScope(directPath, maxBytes, 30_000, fetcher)
      try {
        return await operation()
      } finally {
        scope.close()
        scope = null
      }
    },
  }
}

// Core retries log the signed CDN URL; never persist that URL in Worker logs.
export function redactMediaLog(line: string): string {
  if (/media_?key|failed to (?:stream-)?download from url/i.test(line))
    return "[media diagnostic redacted]"
  return line.replace(/https?:\/\/[^\s"'<>]+/gi, "[URL redacted]")
}
