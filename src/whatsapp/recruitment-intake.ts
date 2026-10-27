import type { MessageInput } from "../store/archive"

declare global {
  interface Env {
    RECRUITMENT_INTAKE_POLICY_JSON?: string
  }
}

type IntakePolicy = {
  enabled: true
  ownerJids: string[]
  endpoint: string
  notBefore: number
  expiresAt: number
  maxEvents: number
}
export type IntakeStorage = {
  sql: {
    exec(query: string, ...bindings: (string | number | null)[]): Iterable<Record<string, unknown>>
  }
  transactionSync<T>(callback: () => T): T
}
export type IntakeTransport = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>

export function parseIntakePolicy(raw: unknown): IntakePolicy | null {
  if (typeof raw !== "string" || raw.length > 2048) return null
  try {
    const p = JSON.parse(raw)
    if (
      !p ||
      Array.isArray(p) ||
      Object.keys(p).toSorted().join(",") !==
        "enabled,endpoint,expiresAt,maxEvents,notBefore,ownerJids"
    )
      return null
    if (
      p.enabled !== true ||
      !Array.isArray(p.ownerJids) ||
      p.ownerJids.length < 1 ||
      p.ownerJids.length > 2
    )
      return null
    if (
      !p.ownerJids.every(
        (j: unknown) => typeof j === "string" && /^\d{5,30}@(s\.whatsapp\.net|lid)$/.test(j),
      )
    )
      return null
    if (new Set(p.ownerJids).size !== p.ownerJids.length) return null
    if (![p.notBefore, p.expiresAt, p.maxEvents].every(Number.isSafeInteger)) return null
    if (
      p.notBefore < 1 ||
      p.expiresAt <= p.notBefore ||
      p.expiresAt - p.notBefore > 30 * 86400 ||
      p.maxEvents < 1 ||
      p.maxEvents > 50
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
      url.pathname !== "/webhook/recruitment-whatsapp-inbox-v6"
    )
      return null
    return p
  } catch {
    return null
  }
}

export function referralReason(m: MessageInput): string | null {
  const text = (m.text ?? "").slice(0, 8000).normalize("NFKC")
  const filename = (m.media?.fileName ?? "").slice(0, 300).normalize("NFKC")
  if (m.kind === "contact") return "contact_card"
  if (
    m.kind === "document" &&
    /(?:\bcv\b|\bresume\b|curriculum|سير[ةه]|السير[ةه])/iu.test(text + " " + filename)
  )
    return "cv_document"
  if (
    /(?:مرشح|ترشيح|باحث عن عمل|سير[ةه] ذاتي[ةه]|أرشح|ارشح|أوصي|اوصي|توصية|\breferr?al\b|\bcandidate\b|\bresume\b|\bcv\b)/iu.test(
      text,
    )
  )
    return "referral_text"
  if (
    /(?:\+\d[\d ()-]{7,18}\d|\b(?:00966|966|0)?5\d{8}\b)/u.test(
      text.replace(/[٠-٩]/g, (c) => String("٠١٢٣٤٥٦٧٨٩".indexOf(c))),
    )
  )
    return "phone_number"
  return null
}

export function intakeEvents(
  policy: IntakePolicy,
  messages: readonly MessageInput[],
  source: "live" | "history",
  accountJid: string | null,
  now: number,
) {
  if (
    source !== "live" ||
    !accountJid ||
    !policy.ownerJids.includes(accountJid) ||
    now < policy.notBefore ||
    now >= policy.expiresAt
  )
    return []
  const events = []
  for (const m of messages) {
    if (
      m.fromMe ||
      policy.ownerJids.includes(m.chatJid) ||
      !/^\d{5,30}@(s\.whatsapp\.net|lid)$/.test(m.chatJid)
    )
      continue
    if (
      !/^[A-Za-z0-9_-]{4,160}$/.test(m.id) ||
      !Number.isSafeInteger(m.sentAt) ||
      m.sentAt < policy.notBefore ||
      m.sentAt < now - 900 ||
      m.sentAt > now + 60
    )
      continue
    const reason = referralReason(m)
    if (!reason) continue
    events.push({
      schema_version: 2,
      event_type: "whatsapp.recruitment.possible_referral",
      account: "personal",
      chat_jid: m.chatJid,
      message_id: m.id,
      reason,
      sent_at: m.sentAt,
    })
    if (events.length >= 10) break
  }
  return events
}

async function receiptMatches(r: Response, id: string): Promise<boolean> {
  const reader = r.body?.getReader()
  if (!reader) return false
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 4096) return false
      chunks.push(part.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const part of chunks) {
      bytes.set(part, offset)
      offset += part.byteLength
    }
    const value = JSON.parse(new TextDecoder().decode(bytes))
    return (
      value.accepted === true &&
      value.needs_human_review === true &&
      value.approval === false &&
      value.messages_sent === 0 &&
      value.message_id === id
    )
  } catch {
    return false
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export async function captureRecruitmentIntake(
  storage: IntakeStorage,
  raw: unknown,
  token: unknown,
  messages: readonly MessageInput[],
  source: "live" | "history",
  accountJid: string | null,
  now = Math.floor(Date.now() / 1000),
  transport: IntakeTransport = fetch,
  onAccepted?: (event: ReturnType<typeof intakeEvents>[number]) => Promise<void>,
): Promise<string[]> {
  const p = parseIntakePolicy(raw)
  if (!p) return ["disabled"]
  if (
    typeof token !== "string" ||
    token.length < 20 ||
    token.length > 8192 ||
    !/^[A-Za-z0-9._~+/-]+=*$/.test(token)
  )
    return ["auth_unconfigured"]
  const results = []
  for (const event of intakeEvents(p, messages, source, accountJid, now)) {
    const key = event.chat_jid + ":" + event.message_id
    const reserved = storage.transactionSync(() => {
      storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS recruitment_intake_delivery (event_key TEXT PRIMARY KEY, message_id TEXT NOT NULL, chat_jid TEXT NOT NULL, reason TEXT NOT NULL, attempted_at INTEGER NOT NULL, status TEXT NOT NULL)",
      )
      if (
        Array.from(
          storage.sql.exec(
            "SELECT event_key FROM recruitment_intake_delivery WHERE event_key = ?",
            key,
          ),
        ).length
      )
        return "duplicate"
      const count = Number(
        Array.from(storage.sql.exec("SELECT COUNT(*) AS count FROM recruitment_intake_delivery"))[0]
          ?.count ?? 0,
      )
      if (count >= p.maxEvents) return "budget_reached"
      storage.sql.exec(
        "INSERT INTO recruitment_intake_delivery(event_key,message_id,chat_jid,reason,attempted_at,status) VALUES(?,?,?,?,?,'reserved')",
        key,
        event.message_id,
        event.chat_jid,
        event.reason,
        now,
      )
      return "reserved"
    })
    if (reserved !== "reserved") {
      results.push(reserved)
      continue
    }
    let status = "unknown_no_retry"
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    try {
      const response = await transport(p.endpoint, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify(event),
      })
      if (response.status >= 200 && response.status < 300) {
        if (await receiptMatches(response, event.message_id)) status = "acknowledged"
      } else {
        await response.body?.cancel().catch(() => {})
        status = "rejected_no_retry"
      }
    } catch {
    } finally {
      clearTimeout(timeout)
    }
    storage.sql.exec(
      "UPDATE recruitment_intake_delivery SET status=? WHERE event_key=?",
      status,
      key,
    )
    results.push(status)
    // Notify only after the review-only inbox has durably acknowledged this pointer.
    // Notification failure must never turn the intake into a second n8n delivery.
    if (status === "acknowledged" && onAccepted) {
      try {
        await onAccepted(event)
      } catch {
        /* The pointer remains in the review inbox. */
      }
    }
  }
  return results
}
