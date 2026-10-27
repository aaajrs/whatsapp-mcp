import {
  parseIntakePolicy,
  type IntakeStorage,
  type IntakeTransport,
} from "../whatsapp/recruitment-intake"
import { z } from "zod"

export const REFERRAL_EVENT = "whatsapp.recruitment.referral_pending"
export type EventAuthority = {
  principal: string
  origin: string
  accountId: string
  kind: "oauth" | "api_key"
  userId?: string
  clientId?: string
  grantId?: string
  keyHash?: string
}
type Arguments = { account: "personal" }
type Subscription = {
  id: string
  authority: EventAuthority
  url: string
  secret: string
  previousSecret: string | null
  rotateUntil: number
  expires: number
  verified: number
  active: boolean
  generation: number
  verifyingUntil: number
  verificationStatus?: number | null
  verificationError?: string | null
  unsubscribedAt?: number
}
export type ReferralPointer = {
  account: string
  chat_jid: string
  message_id: string
  reason: string
  sent_at: number
}
type EventData = {
  account: "personal"
  event_key: string
  chat_jid: string | null
  message_id: string | null
  reason: string
  sent_at: number
  approval: false
  test_only: boolean
  request_key: string | null
}
type PendingEvent = {
  eventId: string
  name: string
  timestamp: string
  data: EventData
  cursor: null
}
type Delivery = {
  event: PendingEvent
  subscriptionId: string
  state: "pending" | "sending" | "accepted" | "failed" | "stopped"
  attempts: number
  nextAttempt: number
  status: number | null
}
type State = {
  subscriptions: Record<string, Subscription>
  deliveries: Record<string, Delivery>
  verificationAttempts: number[]
}
type Runtime = { rawPolicy: unknown; accountJid: string | null; connected: boolean }
type Deps = {
  runtime: () => Runtime
  authorized: (authority: EventAuthority) => Promise<boolean>
  transport?: IntakeTransport
  now?: () => number
}

export class EventError extends Error {
  constructor(
    readonly code: number,
    readonly reason: string,
  ) {
    super(reason)
  }
}
const fail = (reason: string): never => {
  throw new EventError(-32602, reason)
}
const encoder = new TextEncoder()

export async function eventDigest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value))
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("")
}
function secretBytes(secret: unknown): Uint8Array {
  if (typeof secret !== "string" || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret))
    return fail("invalid_secret")
  try {
    const bytes = Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0))
    if (bytes.length < 24 || bytes.length > 64) return fail("invalid_secret")
    return bytes
  } catch {
    return fail("invalid_secret")
  }
}
// This service only sends to the existing ChatGPT/Dot integration. Combined with
// Workers' public fetch and manual redirects, callers cannot select local networks,
// raw IPs, their own DNS names, proxy credentials, or redirect targets.
export function callbackUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) return fail("invalid_callback")
  let u: URL
  try {
    u = new URL(value)
  } catch {
    return fail("invalid_callback")
  }
  if (
    u.protocol !== "https:" ||
    u.port ||
    u.username ||
    u.password ||
    u.hash ||
    !/^(?:[a-z0-9-]+\.)*(?:chatgpt\.com|openai\.com)$/.test(u.hostname)
  )
    return fail("invalid_callback")
  return u.href
}
function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let different = 0
  for (let i = 0; i < a.length; i++) different |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return different === 0
}
export async function eventSignature(secret: string, id: string, timestamp: number, body: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${id}.${timestamp}.${body}`))
  return "v1," + btoa(String.fromCharCode(...new Uint8Array(mac)))
}
function argumentsFor(value: unknown): Arguments {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).join(",") !== "account" ||
    object(value).account !== "personal"
  )
    return fail("invalid_arguments")
  return { account: "personal" }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid_params")
  const parsed = z.record(z.string(), z.unknown()).safeParse(value)
  return parsed.success ? parsed.data : fail("invalid_params")
}
function onlyKeys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((k) => !allowed.includes(k))) fail("unexpected_parameter")
}
const payloadProperties = {
  account: { const: "personal" },
  event_key: { type: "string" },
  chat_jid: { type: ["string", "null"] },
  message_id: { type: ["string", "null"] },
  reason: { enum: ["contact_card", "cv_document", "referral_text", "phone_number", "fixture"] },
  sent_at: { type: "integer" },
  approval: { const: false },
  test_only: { type: "boolean" },
  request_key: { type: ["string", "null"] },
}
export const referralDefinition = {
  name: REFERRAL_EVENT,
  description:
    "A possible WhatsApp recruitment referral is saved for the owner's review. Pointer only; never authorizes candidate contact. The receiving assistant presents an approval request. Test events are marked test_only.",
  delivery: ["webhook"],
  inputSchema: {
    type: "object",
    properties: { account: { type: "string", const: "personal" } },
    required: ["account"],
    additionalProperties: false,
  },
  payloadSchema: {
    type: "object",
    properties: payloadProperties,
    required: Object.keys(payloadProperties),
    additionalProperties: false,
  },
}

/** Persistent in the existing account's SQLite store; no new service or timer. */
export class RecruitmentEvents {
  private readonly now: () => number
  private readonly transport: IntakeTransport
  constructor(
    private readonly storage: IntakeStorage,
    private readonly deps: Deps,
  ) {
    this.now = deps.now ?? (() => Date.now())
    // Worker globals reject calls with an unrelated class instance as `this`.
    this.transport = deps.transport ?? ((url, init) => fetch(url, init))
  }
  private mutate<T>(fn: (state: State) => T): T {
    return this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS recruitment_events_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
      )
      const row = Array.from(
        this.storage.sql.exec("SELECT value FROM recruitment_events_state WHERE id=1"),
      )[0]
      const state: State = row
        ? JSON.parse(String(row.value))
        : { subscriptions: {}, deliveries: {}, verificationAttempts: [] }
      const result = fn(state)
      this.storage.sql.exec(
        "INSERT INTO recruitment_events_state(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        JSON.stringify(state),
      )
      return result
    })
  }
  private policy() {
    const r = this.deps.runtime()
    const p = parseIntakePolicy(r.rawPolicy)
    const now = this.now() / 1000
    return p &&
      r.connected &&
      r.accountJid &&
      p.ownerJids.includes(r.accountJid) &&
      now >= p.notBefore &&
      now < p.expiresAt
      ? p
      : null
  }
  private async identity(authority: EventAuthority, params: unknown, subscribe: boolean) {
    if (authority.accountId !== "personal" || !(await this.deps.authorized(authority)))
      throw new EventError(-32001, "not_authorized")
    const p = object(params)
    onlyKeys(
      p,
      subscribe
        ? ["name", "arguments", "delivery", "cursor", "ttlMs", "_meta"]
        : ["name", "arguments", "delivery", "_meta"],
    )
    if (p.name !== REFERRAL_EVENT) return fail("unknown_event")
    const args = argumentsFor(p.arguments)
    const d = object(p.delivery)
    onlyKeys(d, subscribe ? ["mode", "url", "secret"] : ["mode", "url"])
    if (d.mode !== "webhook") return fail("unsupported_delivery")
    const url = callbackUrl(d.url)
    const id =
      "sub_" + (await eventDigest(JSON.stringify([authority.principal, url, REFERRAL_EVENT, args])))
    return { id, url, p, d }
  }
  async subscribe(authority: EventAuthority, params: unknown) {
    const { id, url, p, d } = await this.identity(authority, params, true)
    const policy = this.policy()
    if (!policy) throw new EventError(-32001, "intake_disabled_or_disconnected")
    if (p.cursor !== undefined && p.cursor !== null) fail("replay_not_supported")
    if (
      p.ttlMs !== undefined &&
      p.ttlMs !== null &&
      (!Number.isSafeInteger(p.ttlMs) || Number(p.ttlMs) <= 0)
    )
      fail("invalid_ttl")
    const secret = typeof d.secret === "string" ? d.secret : fail("invalid_secret")
    secretBytes(secret)
    const now = this.now()
    const expires = Math.min(
      policy.expiresAt * 1000,
      now + Math.min(Number(p.ttlMs ?? 86400000), 86400000),
    )
    const candidate = this.mutate((s) => {
      const existing = s.subscriptions[id]
      if (
        Object.values(s.subscriptions).some(
          (x) => x.id !== id && ((x.active && x.expires > now) || x.verifyingUntil > now),
        )
      )
        throw new EventError(-32001, "one_rayan_subscription_only")
      if (!existing && Object.keys(s.subscriptions).length >= 5)
        throw new EventError(-32001, "subscription_limit")
      const cached =
        !!existing?.active &&
        existing.expires > now &&
        existing.secret === secret &&
        existing.verified > now - 300000
      s.verificationAttempts = s.verificationAttempts.filter((x) => x > now - 3600000)
      if (!cached && s.verificationAttempts.length >= 5)
        throw new EventError(-32015, "verification_rate_limited")
      if (!cached) s.verificationAttempts.push(now)
      const sub: Subscription = {
        id,
        authority,
        url,
        secret,
        previousSecret:
          existing?.active && existing.secret !== secret
            ? existing.secret
            : (existing?.previousSecret ?? null),
        rotateUntil:
          existing?.active && existing.secret !== secret
            ? now + 300000
            : (existing?.rotateUntil ?? 0),
        expires,
        verified: cached ? existing.verified : 0,
        active: false,
        generation: (existing?.generation ?? 0) + 1,
        verifyingUntil: now + 15000,
        verificationStatus: cached ? (existing?.verificationStatus ?? 200) : null,
        verificationError: null,
      }
      s.subscriptions[id] = sub
      return structuredClone(sub)
    })
    if (!candidate.verified) {
      const challenge = crypto.randomUUID()
      let verificationStatus: number | null = null
      let failureReason = "network_error"
      try {
        const response = await this.post(
          candidate,
          "msg_verification_" + crypto.randomUUID(),
          JSON.stringify({ type: "verification", challenge }),
        )
        verificationStatus = response.status
        failureReason = response.ok ? "invalid_challenge_response" : "http_error"
        const reader = response.body?.getReader()
        if (!reader || !response.ok) {
          await response.body?.cancel()
          throw new Error()
        }
        let bytes = new Uint8Array(0)
        try {
          for (;;) {
            const part = await reader.read()
            if (part.done) break
            if (bytes.length + part.value.length > 4096) throw new Error()
            const next = new Uint8Array(bytes.length + part.value.length)
            next.set(bytes)
            next.set(part.value, bytes.length)
            bytes = next
          }
        } finally {
          await reader.cancel().catch(() => {})
        }
        const result = JSON.parse(new TextDecoder().decode(bytes))
        if (typeof result.challenge !== "string" || !equal(result.challenge, challenge))
          throw new Error()
      } catch (error) {
        if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))
          failureReason = "timeout"
        this.mutate((s) => {
          const current = s.subscriptions[id]
          if (!current || current.generation !== candidate.generation) return
          current.verifyingUntil = 0
          current.verificationStatus = verificationStatus
          current.verificationError = failureReason
        })
        throw new EventError(-32015, failureReason)
      }
      candidate.verificationStatus = verificationStatus
    }
    if (!this.policy() || !(await this.deps.authorized(authority)))
      throw new EventError(-32001, "not_authorized")
    this.mutate((s) => {
      const current = s.subscriptions[id]
      if (!current || current.generation !== candidate.generation)
        throw new EventError(-32001, "subscription_changed")
      current.active = true
      current.verifyingUntil = 0
      current.verified = this.now()
      current.verificationStatus = candidate.verificationStatus ?? 200
      current.verificationError = null
    })
    return { id, refreshBefore: new Date(expires).toISOString(), cursor: null, truncated: false }
  }
  async unsubscribe(authority: EventAuthority, params: unknown) {
    const { id } = await this.identity(authority, params, false)
    this.mutate((s) => {
      const sub = s.subscriptions[id]
      if (sub) {
        sub.active = false
        sub.generation++
        sub.verifyingUntil = 0
        sub.secret = ""
        sub.previousSecret = null
        sub.unsubscribedAt = this.now()
      }
      for (const d of Object.values(s.deliveries))
        if (d.subscriptionId === id && (d.state === "pending" || d.state === "sending"))
          d.state = "stopped"
    })
    return {}
  }
  private async post(sub: Subscription, id: string, body: string) {
    const url = callbackUrl(sub.url)
    const timestamp = Math.floor(this.now() / 1000)
    let signature = await eventSignature(sub.secret, id, timestamp, body)
    if (sub.previousSecret && sub.rotateUntil > this.now())
      signature += " " + (await eventSignature(sub.previousSecret, id, timestamp, body))
    return this.transport(url, {
      method: "POST",
      // workerd does not implement "error". Both callers reject non-2xx
      // responses, so manual mode preserves the no-redirect boundary.
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: {
        "Content-Type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": signature,
        "X-MCP-Subscription-Id": sub.id,
      },
      body,
    })
  }
  async enqueue(pointer: ReferralPointer) {
    const p = this.policy()
    if (
      !p ||
      pointer.account !== "personal" ||
      p.ownerJids.includes(pointer.chat_jid) ||
      !/^\d{5,30}@(s\.whatsapp\.net|lid)$/.test(pointer.chat_jid) ||
      !/^[A-Za-z0-9_-]{4,160}$/.test(pointer.message_id) ||
      !["contact_card", "cv_document", "referral_text", "phone_number"].includes(pointer.reason) ||
      !Number.isSafeInteger(pointer.sent_at) ||
      pointer.sent_at < p.notBefore ||
      pointer.sent_at < this.now() / 1000 - 900 ||
      pointer.sent_at > this.now() / 1000 + 60
    )
      return
    await this.queue({
      account: "personal",
      event_key: "WA6:" + pointer.chat_jid + ":" + pointer.message_id,
      chat_jid: pointer.chat_jid,
      message_id: pointer.message_id,
      reason: pointer.reason,
      sent_at: pointer.sent_at,
      approval: false,
      test_only: false,
      request_key: null,
    })
  }
  private async queue(data: EventData) {
    const p = this.policy()
    if (!p) return "disabled"
    const id = "evt_" + (await eventDigest(data.event_key))
    return this.mutate((s) => {
      if (s.deliveries[id]) return "duplicate"
      const sub = Object.values(s.subscriptions).find((x) => x.active && x.expires > this.now())
      if (!sub) return "no_subscription"
      if (
        Object.values(s.deliveries).filter((d) => !d.event.data.test_only).length >= p.maxEvents &&
        !data.test_only
      )
        return "budget_reached"
      s.deliveries[id] = {
        event: {
          eventId: id,
          name: REFERRAL_EVENT,
          timestamp: new Date(data.sent_at * 1000).toISOString(),
          data,
          cursor: null,
        },
        subscriptionId: sub.id,
        state: "pending",
        attempts: 0,
        nextAttempt: this.now(),
        status: null,
      }
      return "queued"
    })
  }
  async test(authority: EventAuthority) {
    if (!(await this.deps.authorized(authority)) || authority.accountId !== "personal")
      throw new EventError(-32001, "not_authorized")
    const sub = this.mutate((s) =>
      Object.values(s.subscriptions).find(
        (x) => x.active && x.expires > this.now() && x.authority.accountId === authority.accountId,
      ),
    )
    if (!sub) throw new EventError(-32001, "no_verified_subscription")
    // A single synthetic notification per subscription. This cannot message WhatsApp.
    const state = await this.queue({
      account: "personal",
      event_key: "FIXTURE:DOT-V7:" + sub.id,
      chat_jid: null,
      message_id: null,
      reason: "fixture",
      sent_at: Math.floor(this.now() / 1000),
      approval: false,
      test_only: true,
      request_key: "RC6:FIXTURE:20261027",
    })
    await this.flush()
    return { state, test_only: true, whatsapp_messages_sent: 0, ...this.status() }
  }
  async flush() {
    if (!this.policy()) return
    // Uses the account's existing 30-second alarm. At most 3 attempts/event, 2/cycle.
    const ready = this.mutate((s) =>
      Object.entries(s.deliveries)
        .filter(
          ([, d]) =>
            (d.state === "pending" || (d.state === "sending" && d.nextAttempt <= this.now())) &&
            d.nextAttempt <= this.now(),
        )
        .slice(0, 2)
        .map(([id]) => id),
    )
    for (const id of ready) {
      const snapshot = this.mutate((s) => {
        const d = s.deliveries[id]
        const sub = d && s.subscriptions[d.subscriptionId]
        if (!d || !sub?.active || sub.expires <= this.now() || d.attempts >= 3) {
          if (d) d.state = "stopped"
          return null
        }
        if (!((d.state === "pending" || d.state === "sending") && d.nextAttempt <= this.now()))
          return null
        d.attempts++
        d.state = "sending"
        d.nextAttempt = this.now() + 30000 * 2 ** (d.attempts - 1)
        return structuredClone({ d, sub })
      })
      if (!snapshot) continue
      const { d, sub } = snapshot
      if (!(await this.deps.authorized(sub.authority)) || !this.policy()) {
        this.mutate((s) => {
          s.deliveries[id]!.state = "stopped"
          s.subscriptions[sub.id]!.active = false
        })
        continue
      }
      // Recheck after access lookup: unsubscribe/refresh can run while it awaited KV.
      if (
        !this.mutate(
          (s) =>
            s.subscriptions[sub.id]?.active &&
            s.subscriptions[sub.id]?.generation === sub.generation,
        )
      )
        continue
      let code: number | null = null
      try {
        const response = await this.post(sub, d.event.eventId, JSON.stringify(d.event))
        code = response.status
        await response.body?.cancel().catch(() => {})
      } catch {
        /* bounded retry, same event ID */
      }
      this.mutate((s) => {
        const current = s.deliveries[id]!
        if (current.state === "stopped") return
        current.status = code
        current.state =
          code !== null && code >= 200 && code < 300
            ? "accepted"
            : current.attempts >= 3 || (code !== null && code !== 408 && code !== 429 && code < 500)
              ? "failed"
              : "pending"
        if (code === 410) s.subscriptions[sub.id]!.active = false
      })
    }
  }
  status() {
    const p = this.policy()
    return this.mutate((s) => ({
      transport_revision: "worker-native-fetch-v1",
      intake_enabled: !!p,
      policy_expires_at: p ? new Date(p.expiresAt * 1000).toISOString() : null,
      subscriptions: Object.values(s.subscriptions).map((x) => ({
        id: x.id,
        active: x.active && x.expires > this.now() && !!p,
        expires_at: new Date(x.expires).toISOString(),
        verified_at: x.verified ? new Date(x.verified).toISOString() : null,
        verification_http_status: x.verificationStatus ?? null,
        verification_error: x.verificationError ?? null,
        unsubscribed_at: x.unsubscribedAt ? new Date(x.unsubscribedAt).toISOString() : null,
      })),
      delivery_counts: Object.fromEntries(
        ["pending", "sending", "accepted", "failed", "stopped"].map((k) => [
          k,
          Object.values(s.deliveries).filter((x) => x.state === k).length,
        ]),
      ),
      last_deliveries: Object.values(s.deliveries)
        .slice(-5)
        .map((x) => ({
          event_id: x.event.eventId,
          state: x.state,
          attempts: x.attempts,
          http_status: x.status,
          test_only: x.event.data.test_only,
        })),
      approval_required: true,
      candidate_contact_enabled_by_event: false,
    }))
  }
}
