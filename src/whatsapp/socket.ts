// Host and Node entrypoints use the same socket. Host callbacks stay byte-oriented.
import type { WASocket } from "@oxidezap/baileyrs"
import makeHostSocket, { type HostSocketConfig } from "@oxidezap/baileyrs/host"
import { createWASocketFactory } from "@oxidezap/baileyrs/lib/Socket/core.js"
import { hostRuntime } from "@oxidezap/baileyrs/lib/Runtime/host.js"
import { createMediaHttpRouter, redactMediaLog } from "./bounded-http"

export type Socket = WASocket & {
  withBoundedMedia<T>(directPath: string, maxBytes: number, operation: () => Promise<T>): Promise<T>
}

let boundedEngineInitialized = false

export function makeSocket(config: HostSocketConfig, mediaEnabled = false): Socket {
  if (!mediaEnabled) {
    const unmodified = Object.assign(makeHostSocket(config), {
      async withBoundedMedia<T>(
        _path: string,
        _max: number,
        _operation: () => Promise<T>,
      ): Promise<T> {
        throw new Error("MEDIA_DISABLED")
      },
    })
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- unchanged original host-to-Node declaration bridge
    return unmodified as unknown as Socket
  }
  const router = createMediaHttpRouter()
  const factory = createWASocketFactory({
    ...hostRuntime,
    loggerSink: (line, delivered) => hostRuntime.loggerSink(redactMediaLog(line), delivered),
    bridge: {
      ...hostRuntime.bridge,
      initWasmEngine: (logger, crypto) => {
        if (!boundedEngineInitialized) {
          hostRuntime.bridge.initWasmEngine(logger, crypto)
          boundedEngineInitialized = true
        }
      },
      createWhatsAppClient: (transport, http, ...rest) =>
        hostRuntime.bridge.createWhatsAppClient(
          transport,
          {
            execute: router.wrap(http.execute.bind(http)),
          },
          ...rest,
        ),
    },
  })
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- host facade forwards this exact config to core; its declarations intentionally omit Node types
  const host = factory(config as unknown as Parameters<typeof factory>[0])
  const socket = Object.assign(host, {
    async withBoundedMedia<T>(
      directPath: string,
      maxBytes: number,
      operation: () => Promise<T>,
    ): Promise<T> {
      return router.run(directPath, maxBytes, operation)
    },
  })
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same underlying socket; host declarations omit Node-only types
  return socket as unknown as Socket
}
