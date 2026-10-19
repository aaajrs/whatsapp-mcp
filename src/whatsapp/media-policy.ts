import type { MediaPolicy } from "./media-read"

// Operator-managed private Worker binding. Never put actual IDs into source.
declare global {
  interface Env {
    MEDIA_POLICY_JSON?: string
  }
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

export function parseMediaPolicy(value: unknown): MediaPolicy | null {
  if (typeof value !== "string" || value.length > 2048) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed)) return null
    const p = parsed
    if (Object.keys(p).toSorted().join(",") !== "groupJid,maxBytes,notBefore,ownerJids") return null
    if (typeof p.groupJid !== "string" || !/^\d{5,30}@g\.us$/.test(p.groupJid)) return null
    if (!Array.isArray(p.ownerJids) || p.ownerJids.length < 1 || p.ownerJids.length > 2) return null
    if (
      !p.ownerJids.every(
        (id: unknown) => typeof id === "string" && /^\d{5,30}@(s\.whatsapp\.net|lid)$/.test(id),
      )
    )
      return null
    if (new Set(p.ownerJids).size !== p.ownerJids.length) return null
    if (
      typeof p.maxBytes !== "number" ||
      !Number.isSafeInteger(p.maxBytes) ||
      p.maxBytes < 1 ||
      p.maxBytes > 2097152
    )
      return null
    if (
      typeof p.notBefore !== "number" ||
      !Number.isSafeInteger(p.notBefore) ||
      p.notBefore < 1 ||
      p.notBefore > 4102444800
    )
      return null
    return {
      groupJid: p.groupJid,
      ownerJids: p.ownerJids,
      maxBytes: p.maxBytes,
      notBefore: p.notBefore,
    }
  } catch {
    return null // No values or parsing errors logged: binding contains private IDs.
  }
}
