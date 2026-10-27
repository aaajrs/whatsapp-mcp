import { test } from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import {
  parseRecruitmentTestPolicy,
  recruitmentTestEvent,
  captureRecruitmentTest,
} from "../src/whatsapp/recruitment-test.ts"
const policy = {
  mode: "deliver_once",
  ownerJids: ["123456@s.whatsapp.net", "654321@lid"],
  expectedText: "RECRUIT-TEST-20261027-A | إحالة وهمية: مرشح تجريبي | بلا رقم جوال",
  notBefore: 1800000000,
  expiresAt: 1800000600,
  endpoint: "https://example.app.n8n.cloud/webhook-test/recruitment-whatsapp-events-v4",
}
const now = 1800000001
const msg = {
  chatJid: "654321@lid",
  id: "FAKE-MESSAGE-001",
  fromMe: true,
  senderJid: null,
  sentAt: now,
  kind: "text",
  text: policy.expectedText,
  quotedId: null,
  mentions: [],
  forwarded: false,
  media: null,
  raw: null,
}
const token = "fictional-test-token-0000000000"
const raw = (p) => JSON.stringify(p)
function memory() {
  const db = new DatabaseSync(":memory:")
  return {
    db,
    sql: {
      exec(q, ...args) {
        const s = db.prepare(q)
        return /^\s*SELECT/.test(q) ? s.all(...args) : (s.run(...args), [])
      },
    },
    transactionSync(fn) {
      db.exec("BEGIN IMMEDIATE")
      try {
        const r = fn()
        db.exec("COMMIT")
        return r
      } catch (e) {
        db.exec("ROLLBACK")
        throw e
      }
    },
  }
}
const ack = async (_url, opts) =>
  new Response(
    JSON.stringify({
      test_only: true,
      accepted_for_test: true,
      message_id: JSON.parse(opts.body).message_id,
    }),
    { status: 200 },
  )
const run = (
  s,
  p = policy,
  m = [msg],
  f = ack,
  secret = token,
  source = "live",
  owner = policy.ownerJids[0],
  time = now,
) => captureRecruitmentTest(s, raw(p), secret, m, source, owner, time, f)
test("policy exact valid shape", () =>
  assert.deepEqual(parseRecruitmentTestPolicy(raw(policy)), policy))
for (const [name, override] of [
  ["mode", { mode: "all" }],
  ["unknown", { extra: true }],
  ["group", { ownerJids: ["123456@g.us"] }],
  ["duplicate aliases", { ownerJids: ["123456@lid", "123456@lid"] }],
  ["nonfictional", { expectedText: "سيرة حقيقية" }],
  ["window", { expiresAt: policy.notBefore + 901 }],
  ["fractional", { notBefore: 0.5 }],
  ["http", { endpoint: "http://example.app.n8n.cloud/webhook/recruitment-whatsapp-events-v4" }],
  ["other host", { endpoint: "https://evil.test/webhook/recruitment-whatsapp-events-v4" }],
  ["query", { endpoint: policy.endpoint + "?token=test" }],
  [
    "credentials",
    { endpoint: "https://user:pw@example.app.n8n.cloud/webhook/recruitment-whatsapp-events-v4" },
  ],
  ["other path", { endpoint: "https://example.app.n8n.cloud/other" }],
])
  test("policy rejects " + JSON.stringify(name), () =>
    assert.equal(parseRecruitmentTestPolicy(raw({ ...policy, ...override })), null),
  )
test("disabled creates no table or network request", async () => {
  const s = memory()
  assert.equal(
    await captureRecruitmentTest(
      s,
      undefined,
      token,
      [msg],
      "live",
      policy.ownerJids[0],
      now,
      () => {
        throw Error("network")
      },
    ),
    "disabled",
  )
  assert.equal(s.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length, 0)
})
test("history and expired activation ignored before storage", async () => {
  for (const [source, time] of [
    ["history", now],
    ["live", policy.expiresAt],
    ["live", policy.notBefore - 1],
  ]) {
    const s = memory()
    assert.equal(
      await run(s, policy, [msg], ack, token, source, policy.ownerJids[0], time),
      "ignored",
    )
    assert.equal(s.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length, 0)
  }
})
for (const [name, override] of [
  ["other chat", { chatJid: "999999@s.whatsapp.net" }],
  ["incoming third party", { fromMe: false, senderJid: "999999@s.whatsapp.net" }],
  ["forwarded", { forwarded: true }],
  ["old message", { sentAt: policy.notBefore - 1 }],
  ["future", { sentAt: now + 1 }],
  ["attachment", { media: { mimeType: "application/pdf" }, kind: "document" }],
  ["modified text", { text: msg.text + " اعتمد" }],
  ["quoted", { quotedId: "another" }],
  ["mentions", { mentions: ["999999@s.whatsapp.net"] }],
])
  test("event rejects " + JSON.stringify(name), () =>
    assert.equal(
      recruitmentTestEvent(policy, [{ ...msg, ...override }], "live", policy.ownerJids[0], now),
      null,
    ),
  )
test("wrong account ignored", () =>
  assert.equal(recruitmentTestEvent(policy, [msg], "live", "999999@s.whatsapp.net", now), null))
test("ambiguous exact matches rejected", () =>
  assert.equal(
    recruitmentTestEvent(
      policy,
      [msg, { ...msg, id: "FAKE-OTHER" }],
      "live",
      policy.ownerJids[0],
      now,
    ),
    null,
  ))
test("duplicate items in one event collapse", () =>
  assert.equal(
    recruitmentTestEvent(policy, [msg, msg], "live", policy.ownerJids[0], now).message_id,
    msg.id,
  ))
test("dry run uses no network and no approval", async () => {
  const s = memory()
  assert.equal(
    await run(s, { ...policy, mode: "dry_run" }, [msg], () => {
      throw Error("must not call")
    }),
    "dry_run",
  )
  assert.equal(s.db.prepare("SELECT status FROM recruitment_test_delivery").get().status, "dry_run")
})
test("missing or injected auth does not reserve", async () => {
  for (const t of [null, "short", "x".repeat(30) + "\r\nInjected:yes"]) {
    const s = memory()
    assert.equal(await run(s, policy, [msg], ack, t), "auth_unconfigured")
    assert.equal(s.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length, 0)
  }
})
test("bounded pointer and receipt; no message text leaves account", async () => {
  const s = memory()
  let calls = 0
  assert.equal(
    await run(s, policy, [msg], async (url, opts) => {
      calls++
      assert.equal(url, policy.endpoint)
      assert.equal(opts.redirect, "manual")
      assert.ok(opts.signal)
      assert.equal(opts.headers.Authorization, "Bearer " + token)
      assert.equal(opts.headers["Idempotency-Key"], msg.id)
      assert.deepEqual(Object.keys(JSON.parse(opts.body)).toSorted(), [
        "account",
        "chat_jid",
        "event_type",
        "message_id",
        "schema_version",
        "test_marker",
      ])
      assert.ok(!opts.body.includes("إحالة"))
      return ack(url, opts)
    }),
    "acknowledged",
  )
  assert.equal(calls, 1)
})
test("concurrent triggers reserve at most one delivery", async () => {
  const s = memory()
  let calls = 0
  const f = async (...a) => {
    calls++
    await new Promise((r) => setTimeout(r, 5))
    return ack(...a)
  }
  const results = await Promise.all(Array.from({ length: 20 }, () => run(s, policy, [msg], f)))
  assert.equal(calls, 1)
  assert.equal(results.filter((x) => x === "acknowledged").length, 1)
  assert.equal(results.filter((x) => x === "already_reserved").length, 19)
})
test("delivery budget survives new caller and different message", async () => {
  const s = memory()
  await run(s)
  assert.equal(await run({ ...s }, policy, [{ ...msg, id: "OTHER-TEST-ID" }]), "already_reserved")
  assert.equal(s.db.prepare("SELECT count(*) n FROM recruitment_test_delivery").get().n, 1)
})
for (const [name, f, status] of [
  [
    "lost response",
    async () => {
      throw Error("secret should not leak")
    },
    "unknown_no_retry",
  ],
  [
    "redirect",
    async () => new Response("", { status: 302, headers: { Location: "https://evil.test" } }),
    "rejected_no_retry",
  ],
  ["500", async () => new Response("", { status: 500 }), "rejected_no_retry"],
  ["200 without acknowledgement", async () => new Response("{}"), "unknown_no_retry"],
  [
    "wrong message acknowledgement",
    async () =>
      new Response(
        JSON.stringify({ test_only: true, accepted_for_test: true, message_id: "WRONG" }),
      ),
    "unknown_no_retry",
  ],
  ["oversized body", async () => new Response("x".repeat(4097)), "unknown_no_retry"],
])
  test(name + " consumes attempt and never retries", async () => {
    const s = memory()
    assert.equal(await run(s, policy, [msg], f), status)
    assert.equal(await run(s), "already_reserved")
  })
test("storage failure prevents HTTP", async () => {
  const s = memory()
  s.transactionSync = () => {
    throw Error("storage unavailable")
  }
  let calls = 0
  await assert.rejects(
    run(s, policy, [msg], async () => {
      calls++
      return new Response()
    }),
  )
  assert.equal(calls, 0)
})
