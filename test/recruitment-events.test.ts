import { test, expect } from "bun:test"
import { createHmac } from "node:crypto"
import {
  RecruitmentEvents,
  REFERRAL_EVENT,
  callbackUrl,
  eventSignature,
  type EventAuthority,
} from "../src/mcp/recruitment-events"
import { captureRecruitmentIntake, type IntakeTransport } from "../src/whatsapp/recruitment-intake"
import { memoryDatabase } from "./memory-database"

async function expectFailure(promise: Promise<unknown>, message = "") {
  const error = await promise.then(
    () => null,
    (e) => e,
  )
  expect(error).toBeInstanceOf(Error)
  expect(error.message).toContain(message)
}
const secret = "whsec_" + btoa("fictional-webhook-signing-key-1234")
const authority: EventAuthority = {
  kind: "oauth",
  accountId: "personal",
  origin: "https://worker.example",
  principal: "fixture-owner",
  userId: "owner",
  clientId: "fixture-client",
  grantId: "fixture-grant",
}
const params = {
  name: REFERRAL_EVENT,
  arguments: { account: "personal" },
  delivery: { mode: "webhook", url: "https://chatgpt.com/mcp-events/fixture", secret },
}
const pointer = {
  account: "personal",
  chat_jid: "123456789@lid",
  message_id: "FIXTURE-DOT-0001",
  reason: "referral_text",
  sent_at: 1800000000,
}
const policy = {
  enabled: true,
  ownerJids: ["15550000000@s.whatsapp.net"],
  endpoint: "https://example.app.n8n.cloud/webhook/recruitment-whatsapp-inbox-v6",
  notBefore: 1799999990,
  expiresAt: 1800003600,
  maxEvents: 3,
}
function fixture() {
  const storage = memoryDatabase()
  let now = 1800000000000
  let authorized = true
  let connected = true
  let httpStatus = 200
  let verify = true
  const calls: { body: any; options: RequestInit }[] = []
  const deps = {
    runtime: () => ({
      rawPolicy: JSON.stringify(policy),
      accountJid: policy.ownerJids[0]!,
      connected,
    }),
    authorized: async () => authorized,
    now: () => now,
    transport: (async (_url, options) => {
      if (typeof options?.body !== "string") throw new Error("expected serialized JSON")
      const body = JSON.parse(options.body)
      calls.push({ body, options })
      return body.type === "verification"
        ? Response.json({ challenge: verify ? body.challenge : "wrong" })
        : new Response(null, { status: httpStatus })
    }) satisfies IntakeTransport,
  }
  return {
    storage,
    deps,
    calls,
    service: new RecruitmentEvents(storage, deps),
    tick: (ms: number) => {
      now += ms
    },
    revoke: () => {
      authorized = false
    },
    disconnect: () => {
      connected = false
    },
    status: (s: number) => {
      httpStatus = s
    },
    badChallenge: () => {
      verify = false
    },
  }
}
const stop = { ...params, delivery: { mode: "webhook", url: params.delivery.url } }

test("callback destinations exclude attacker hosts, local networks, credentials, redirects and ports", () => {
  for (const url of [
    "http://chatgpt.com/a",
    "https://chatgpt.com.evil.test/a",
    "https://localhost/a",
    "https://127.0.0.1/a",
    "https://[::1]/a",
    "https://chatgpt.com@evil.test/a",
    "https://user@chatgpt.com/a",
    "https://chatgpt.com:444/a",
    "https://chatgpt.com/a#secret",
    "https://evil.test/a",
  ])
    expect(() => callbackUrl(url)).toThrow()
  expect(callbackUrl(params.delivery.url)).toBe(params.delivery.url)
})
test("Standard Webhooks signature matches an independent HMAC", async () => {
  const body = '{"test":true}'
  const expected = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
    .update("evt_1.1800000000." + body)
    .digest("base64")
  expect(await eventSignature(secret, "evt_1", 1800000000, body)).toBe("v1," + expected)
})
test("verification precedes activation; repeated subscribe is deterministic and cached", async () => {
  const f = fixture()
  const a = await f.service.subscribe(authority, params)
  const b = await f.service.subscribe(authority, params)
  expect(a.id).toBe(b.id)
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]!.body.type).toBe("verification")
  expect(f.calls[0]!.options.redirect).toBe("error")
  expect(f.service.status().subscriptions[0]?.active).toBe(true)
  expect(JSON.stringify(f.service.status())).not.toContain(secret)
  expect(JSON.stringify(f.service.status())).not.toContain(params.delivery.url)
})
test("wrong callback challenge leaves delivery disabled", async () => {
  const f = fixture()
  f.badChallenge()
  await expectFailure(f.service.subscribe(authority, params), "invalid_challenge_response")
  await f.service.enqueue(pointer)
  await f.service.flush()
  expect(f.calls).toHaveLength(1)
  expect(f.service.status().subscriptions[0]?.active).toBe(false)
})
test("reject invalid event, arguments, signing key, cursor, ttl and extra fields", async () => {
  const f = fixture()
  for (const p of [
    { ...params, name: "all_messages" },
    { ...params, arguments: {} },
    { ...params, arguments: { account: "other" } },
    { ...params, delivery: { ...params.delivery, secret: "whsec_YQ==" } },
    { ...params, cursor: "replay" },
    { ...params, ttlMs: -1 },
    { ...params, send: true },
  ])
    await expectFailure(f.service.subscribe(authority, p))
  expect(f.calls).toHaveLength(0)
})
test("no subscription means no delivery; no retroactive replay", async () => {
  const f = fixture()
  await f.service.enqueue(pointer)
  await f.service.flush()
  expect(f.calls).toHaveLength(0)
  await f.service.subscribe(authority, params)
  await f.service.flush()
  expect(f.calls).toHaveLength(1)
})
test("one active Rayan receiver only, including concurrent verification", async () => {
  const f = fixture()
  await f.service.subscribe(authority, params)
  await expectFailure(
    f.service.subscribe(authority, {
      ...params,
      delivery: { ...params.delivery, url: params.delivery.url + "-second" },
    }),
    "one_rayan_subscription_only",
  )
})
test("durable idempotent deliveries persist across server restart and carry no instructions or body", async () => {
  const f = fixture()
  await f.service.subscribe(authority, params)
  await f.service.enqueue(pointer)
  await f.service.enqueue(pointer)
  const restarted = new RecruitmentEvents(f.storage, f.deps)
  await Promise.all([restarted.flush(), f.service.flush()])
  expect(f.calls).toHaveLength(2)
  const e = f.calls[1]!.body
  expect(e.name).toBe(REFERRAL_EVENT)
  expect(e.data.event_key).toBe("WA6:" + pointer.chat_jid + ":" + pointer.message_id)
  expect(e.data.approval).toBe(false)
  expect(e.data.test_only).toBe(false)
  expect(e.data.text).toBeUndefined()
  expect(restarted.status().delivery_counts.accepted).toBe(1)
})
test("only acknowledged n8n receipts generate the event, duplicate intake does not", async () => {
  const f = fixture()
  await f.service.subscribe(authority, params)
  const message = {
    chatJid: pointer.chat_jid,
    id: pointer.message_id,
    fromMe: false,
    senderJid: null,
    sentAt: pointer.sent_at,
    kind: "text" as const,
    text: "أرشح لك شخصاً للتسويق",
    quotedId: null,
    mentions: [],
    forwarded: false,
    media: null,
    raw: null,
  }
  let accepted = false
  const transport: IntakeTransport = async () =>
    Response.json({
      accepted,
      needs_human_review: true,
      approval: false,
      messages_sent: 0,
      message_id: message.id,
    })
  const run = () =>
    captureRecruitmentIntake(
      f.storage,
      JSON.stringify(policy),
      "fictional-intake-token-123456789",
      [message],
      "live",
      policy.ownerJids[0]!,
      pointer.sent_at,
      transport,
      async (e) => {
        await f.service.enqueue(e)
      },
    )
  await run()
  accepted = true
  await run()
  await f.service.flush()
  expect(f.calls).toHaveLength(1)
  message.id += "-accepted"
  await run()
  await run()
  await f.service.flush()
  expect(f.calls).toHaveLength(2)
})
test("retries preserve event ID, have backoff and stop at three total attempts", async () => {
  const f = fixture()
  await f.service.subscribe(authority, params)
  f.status(503)
  await f.service.enqueue(pointer)
  await f.service.flush()
  await f.service.flush()
  expect(f.calls).toHaveLength(2)
  f.tick(30000)
  await f.service.flush()
  f.tick(60000)
  await f.service.flush()
  f.tick(120000)
  await f.service.flush()
  expect(f.calls).toHaveLength(4)
  expect(new Set(f.calls.slice(1).map((x) => x.body.eventId)).size).toBe(1)
  expect(f.service.status().delivery_counts.failed).toBe(1)
})
test("410, 413 and redirects are terminal; 410 disables subscription", async () => {
  for (const status of [410, 413, 302]) {
    const f = fixture()
    await f.service.subscribe(authority, params)
    f.status(status)
    await f.service.enqueue(pointer)
    await f.service.flush()
    f.tick(120000)
    await f.service.flush()
    expect(f.calls).toHaveLength(2)
    expect(f.service.status().delivery_counts.failed).toBe(1)
    if (status === 410) expect(f.service.status().subscriptions[0]?.active).toBe(false)
  }
})
test("revocation, disconnect, policy expiry and subscription expiry stop delivery", async () => {
  for (const stopNow of [
    (f: ReturnType<typeof fixture>) => f.revoke(),
    (f: ReturnType<typeof fixture>) => f.disconnect(),
    (f: ReturnType<typeof fixture>) => f.tick(3601000),
  ]) {
    const f = fixture()
    await f.service.subscribe(authority, params)
    await f.service.enqueue(pointer)
    stopNow(f)
    await f.service.flush()
    expect(f.calls).toHaveLength(1)
  }
  const f = fixture()
  await f.service.subscribe(authority, { ...params, ttlMs: 1000 })
  await f.service.enqueue(pointer)
  f.tick(1001)
  await f.service.flush()
  expect(f.calls).toHaveLength(1)
})
test("unsubscribe persists and repeated unsubscribe is safe", async () => {
  const f = fixture()
  await f.service.subscribe(authority, params)
  await f.service.enqueue(pointer)
  await f.service.unsubscribe(authority, stop)
  await f.service.unsubscribe(authority, stop)
  await new RecruitmentEvents(f.storage, f.deps).flush()
  expect(f.calls).toHaveLength(1)
  expect(f.service.status().delivery_counts.stopped).toBe(1)
})
test("unrelated principals cannot unsubscribe another receiver", async () => {
  const f = fixture()
  await f.service.subscribe(authority, params)
  await f.service.unsubscribe({ ...authority, principal: "other-owner" }, stop)
  expect(f.service.status().subscriptions[0]?.active).toBe(true)
})
test("rotation signs with both keys briefly and verifies replacement secret", async () => {
  const f = fixture()
  await f.service.subscribe(authority, params)
  await f.service.subscribe(authority, {
    ...params,
    delivery: { ...params.delivery, secret: "whsec_" + btoa("replacement-fictional-secret-12345") },
  })
  await f.service.enqueue(pointer)
  await f.service.flush()
  expect(f.calls).toHaveLength(3)
  expect(
    new Headers(f.calls[2]!.options.headers).get("webhook-signature")?.split(" "),
  ).toHaveLength(2)
})
test("budget cap excludes duplicates and ignores owner/group/old/unrelated pointers", async () => {
  const f = fixture()
  await f.service.subscribe(authority, params)
  for (const extra of [
    { chat_jid: policy.ownerJids[0]! },
    { chat_jid: "123@g.us" },
    { sent_at: 1 },
    { reason: "unrelated" },
  ])
    await f.service.enqueue({ ...pointer, ...extra })
  for (let i = 0; i < 5; i++)
    await f.service.enqueue({ ...pointer, message_id: pointer.message_id + i })
  await f.service.flush()
  await f.service.flush()
  expect(f.calls).toHaveLength(4)
  expect(f.service.status().delivery_counts.accepted).toBe(3)
})
test("synthetic test is one-shot, marked test-only and cannot send to WhatsApp", async () => {
  const f = fixture()
  await f.service.subscribe(authority, params)
  const a = await f.service.test(authority)
  const b = await f.service.test(authority)
  expect(a.whatsapp_messages_sent).toBe(0)
  expect(b.state).toBe("duplicate")
  expect(f.calls).toHaveLength(2)
  expect(f.calls[1]!.body.data).toMatchObject({
    test_only: true,
    approval: false,
    chat_jid: null,
    message_id: null,
    request_key: "RC6:FIXTURE:20261027",
  })
})

test("callback diagnostics distinguish HTTP rejection and timeout without exposing endpoint or response", async () => {
  for (const timeout of [false, true]) {
    const f = fixture()
    f.deps.transport = async () => {
      if (timeout) throw new DOMException("private callback details", "TimeoutError")
      return new Response("private callback details", { status: 403 })
    }
    const service = new RecruitmentEvents(f.storage, f.deps)
    await expectFailure(service.subscribe(authority, params), timeout ? "timeout" : "http_error")
    const sub = service.status().subscriptions[0]!
    expect(sub.active).toBe(false)
    expect(sub.verification_http_status).toBe(timeout ? null : 403)
    expect(sub.verification_error).toBe(timeout ? "timeout" : "http_error")
    const visible = JSON.stringify(service.status())
    expect(visible).not.toContain(secret)
    expect(visible).not.toContain(params.delivery.url)
    expect(visible).not.toContain("private callback details")
  }
})

test("status distinguishes successful verification followed by unsubscribe", async () => {
  const f = fixture()
  await f.service.subscribe(authority, params)
  expect(f.service.status().subscriptions[0]!.verified_at).not.toBeNull()
  await f.service.unsubscribe(authority, stop)
  const sub = f.service.status().subscriptions[0]!
  expect(sub.active).toBe(false)
  expect(sub.verification_error).toBeNull()
  expect(sub.unsubscribed_at).not.toBeNull()
})
