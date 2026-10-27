import type { MessageInput } from "../store/archive"

// Optional operator-owned configuration; never populated from message content.
declare global {
  interface Env {
    RECRUITMENT_TEST_POLICY_JSON?: string
    RECRUITMENT_WEBHOOK_TOKEN?: string
  }
}

export interface RecruitmentTestPolicy {
  mode: "dry_run" | "deliver_once"
  ownerJids: string[]
  expectedText: string
  notBefore: number
  expiresAt: number
  endpoint: string
}

interface TestStorage {
  sql: {
    exec(query: string, ...bindings: (string | number | null)[]): Iterable<Record<string, unknown>>
  }
  transactionSync<T>(callback: () => T): T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function parseRecruitmentTestPolicy(raw: unknown): RecruitmentTestPolicy | null {
  if (typeof raw !== "string" || raw.length > 4096) return null
  try {
    const p: unknown = JSON.parse(raw)
    if (!isRecord(p)) return null
    if (
      Object.keys(p).toSorted().join(",") !==
      "endpoint,expectedText,expiresAt,mode,notBefore,ownerJids"
    )
      return null
    if (p.mode !== "dry_run" && p.mode !== "deliver_once") return null
    if (!Array.isArray(p.ownerJids) || p.ownerJids.length < 1 || p.ownerJids.length > 2) return null
    if (
      !p.ownerJids.every(
        (id: unknown) => typeof id === "string" && /^\d{5,30}@(s\.whatsapp\.net|lid)$/.test(id),
      )
    )
      return null
    if (new Set(p.ownerJids).size !== p.ownerJids.length) return null
    if (
      typeof p.expectedText !== "string" ||
      p.expectedText.length > 500 ||
      !/^RECRUIT-TEST-\d{8}-[A-Z0-9]{1,16} \| إحالة وهمية:/.test(p.expectedText) ||
      !p.expectedText.endsWith(" | بلا رقم جوال")
    )
      return null
    if (
      typeof p.notBefore !== "number" ||
      typeof p.expiresAt !== "number" ||
      !Number.isSafeInteger(p.notBefore) ||
      !Number.isSafeInteger(p.expiresAt) ||
      p.notBefore < 1 ||
      p.expiresAt <= p.notBefore ||
      p.expiresAt - p.notBefore > 900
    )
      return null
    if (typeof p.endpoint !== "string" || p.endpoint.length > 250) return null
    const url = new URL(p.endpoint)
    if (
      url.protocol !== "https:" ||
      !/^[a-z0-9-]+\.app\.n8n\.cloud$/.test(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      ![
        "/webhook/recruitment-whatsapp-events-v4",
        "/webhook-test/recruitment-whatsapp-events-v4",
      ].includes(url.pathname)
    )
      return null
    return {
      mode: p.mode,
      ownerJids: p.ownerJids,
      expectedText: p.expectedText,
      notBefore: p.notBefore,
      expiresAt: p.expiresAt,
      endpoint: p.endpoint,
    }
  } catch {
    return null
  }
}

export function recruitmentTestEvent(
  policy: RecruitmentTestPolicy,
  messages: readonly MessageInput[],
  source: "live" | "history",
  accountJid: string | null,
  now: number,
) {
  if (
    source !== "live" ||
    !accountJid ||
    !policy.ownerJids.includes(accountJid) ||
    !Number.isSafeInteger(now) ||
    now < policy.notBefore ||
    now >= policy.expiresAt
  )
    return null
  const eligible = messages.filter(
    (m) =>
      policy.ownerJids.includes(m.chatJid) &&
      m.fromMe &&
      m.senderJid === null &&
      m.kind === "text" &&
      !m.forwarded &&
      m.quotedId === null &&
      m.mentions.length === 0 &&
      m.media === null &&
      m.text === policy.expectedText &&
      /^[A-Za-z0-9_-]{4,160}$/.test(m.id) &&
      Number.isSafeInteger(m.sentAt) &&
      m.sentAt >= policy.notBefore &&
      m.sentAt <= now,
  )
  const unique = [...new Map(eligible.map((m) => [m.id, m])).values()]
  if (unique.length !== 1) return null
  const m = unique[0]!
  // Minimal pointer only: no CV, text, contact details, approval or bearer token.
  return {
    schema_version: 1,
    event_type: "whatsapp.test_message.received",
    account: "personal",
    chat_jid: m.chatJid,
    message_id: m.id,
    test_marker: policy.expectedText.split(" | ")[0]!,
  }
}

function reserve(storage: TestStorage, mode: string, messageId: string, now: number): boolean {
  return storage.transactionSync(() => {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS recruitment_test_delivery (mode TEXT PRIMARY KEY CHECK(mode IN ('dry_run','deliver_once')), message_id TEXT NOT NULL, attempted_at INTEGER NOT NULL, status TEXT NOT NULL)",
    )
    if (
      Array.from(
        storage.sql.exec("SELECT mode FROM recruitment_test_delivery WHERE mode = ?", mode),
      ).length
    )
      return false
    storage.sql.exec(
      "INSERT INTO recruitment_test_delivery (mode, message_id, attempted_at, status) VALUES (?, ?, ?, 'reserved')",
      mode,
      messageId,
      now,
    )
    return true
  })
}

async function readReceipt(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("EMPTY_RECEIPT")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 4096) throw new Error("RECEIPT_TOO_LARGE")
      chunks.push(part.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

export async function captureRecruitmentTest(
  storage: TestStorage,
  rawPolicy: unknown,
  token: unknown,
  messages: readonly MessageInput[],
  source: "live" | "history",
  accountJid: string | null,
  now = Math.floor(Date.now() / 1000),
  transport: typeof fetch = fetch,
): Promise<string> {
  const policy = parseRecruitmentTestPolicy(rawPolicy)
  if (!policy) return "disabled"
  const event = recruitmentTestEvent(policy, messages, source, accountJid, now)
  if (!event) return "ignored"
  const bearer = typeof token === "string" ? token : ""
  if (
    policy.mode === "deliver_once" &&
    (bearer.length < 20 || bearer.length > 8192 || !/^[A-Za-z0-9._~+/-]+=*$/.test(bearer))
  )
    return "auth_unconfigured"
  if (!reserve(storage, policy.mode, event.message_id, now)) return "already_reserved"
  let status = "dry_run"
  if (policy.mode === "deliver_once") {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    status = "unknown_no_retry"
    try {
      const response = await transport(policy.endpoint, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
          "Idempotency-Key": event.message_id,
        },
        body: JSON.stringify(event),
      })
      if (response.status >= 200 && response.status < 300) {
        const receipt = await readReceipt(response)
        if (
          isRecord(receipt) &&
          receipt.test_only === true &&
          receipt.accepted_for_test === true &&
          receipt.message_id === event.message_id
        )
          status = "acknowledged"
      } else {
        await response.body?.cancel().catch(() => {})
        status = "rejected_no_retry"
      }
    } catch {
      // A lost response can follow a successful remote write. Never auto-retry.
    } finally {
      clearTimeout(timeout)
    }
  }
  storage.sql.exec(
    "UPDATE recruitment_test_delivery SET status = ? WHERE mode = ?",
    status,
    policy.mode,
  )
  return status
}
