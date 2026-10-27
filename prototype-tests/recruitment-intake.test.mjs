import { test } from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import {
  parseIntakePolicy,
  intakeEvents,
  captureRecruitmentIntake,
} from "../src/whatsapp/recruitment-intake.ts"
const policy = {
  enabled: true,
  ownerJids: ["123456@s.whatsapp.net"],
  endpoint: "https://example.app.n8n.cloud/webhook/recruitment-whatsapp-inbox-v6",
  notBefore: 1800000000,
  expiresAt: 1800000600,
  maxEvents: 3,
}
const now = 1800000001
const msg = {
  chatJid: "111111@lid",
  id: "FIXTURE-INBOX-001",
  fromMe: false,
  senderJid: null,
  sentAt: now,
  kind: "text",
  text: "أرشح لك شخصًا للتسويق",
  quotedId: null,
  mentions: [],
  forwarded: false,
  media: null,
  raw: null,
}
function storage() {
  const db = new DatabaseSync(":memory:")
  return {
    db,
    sql: {
      exec(q, ...v) {
        const s = db.prepare(q)
        return /^\s*SELECT/.test(q) ? s.all(...v) : (s.run(...v), [])
      },
    },
    transactionSync(fn) {
      db.exec("BEGIN IMMEDIATE")
      try {
        const v = fn()
        db.exec("COMMIT")
        return v
      } catch (e) {
        db.exec("ROLLBACK")
        throw e
      }
    },
  }
}
const token = "fictional-intake-token-123456789"
const ack = async (url, opts) =>
  new Response(
    JSON.stringify({
      accepted: true,
      needs_human_review: true,
      approval: false,
      messages_sent: 0,
      message_id: JSON.parse(opts.body).message_id,
    }),
  )
const run = (s, m = [msg], f = ack, p = policy, src = "live", owner = policy.ownerJids[0]) =>
  captureRecruitmentIntake(s, JSON.stringify(p), token, m, src, owner, now, f)
void test("strict policy denies other endpoint or costs above cap", () => {
  assert.ok(parseIntakePolicy(JSON.stringify(policy)))
  for (const override of [
    { maxEvents: 51 },
    { enabled: false },
    { endpoint: "https://evil.test/" },
    { ownerJids: ["123@g.us"] },
    { extra: true },
    { expiresAt: policy.notBefore + 31 * 86400 },
  ])
    assert.equal(parseIntakePolicy(JSON.stringify({ ...policy, ...override })), null)
})
void test("history, self, outbound, group, stale and unrelated messages are ignored", () => {
  for (const m of [
    { ...msg, fromMe: true },
    { ...msg, chatJid: policy.ownerJids[0] },
    { ...msg, chatJid: "123456@g.us" },
    { ...msg, sentAt: 1 },
    { ...msg, text: "صباح الخير" },
  ])
    assert.deepEqual(intakeEvents(policy, [m], "live", policy.ownerJids[0], now), [])
  assert.deepEqual(intakeEvents(policy, [msg], "history", policy.ownerJids[0], now), [])
})
void test("detects CV metadata, contact card and phone as possible referral only", () => {
  for (const m of [
    { ...msg, text: null, kind: "document", media: { fileName: "updated CV.pdf" } },
    { ...msg, kind: "contact", text: null },
    { ...msg, text: "هذا رقم ٠٥٠١٢٣٤٥٦٧" },
  ])
    assert.equal(intakeEvents(policy, [m], "live", policy.ownerJids[0], now).length, 1)
})
void test("pointer contains no text, file, candidate phone, approval or secrets", async () => {
  const s = storage()
  let payload
  await run(s, [msg], async (url, o) => {
    payload = JSON.parse(o.body)
    assert.equal(o.redirect, "manual")
    return ack(url, o)
  })
  assert.deepEqual(Object.keys(payload).toSorted(), [
    "account",
    "chat_jid",
    "event_type",
    "message_id",
    "reason",
    "schema_version",
    "sent_at",
  ])
  assert.equal(JSON.stringify(payload).includes(msg.text), false)
  s.db.close()
})
void test("duplicate and concurrent events reserve one dispatch", async () => {
  const s = storage()
  let sent = 0
  const f = async (...a) => {
    sent++
    return ack(...a)
  }
  await Promise.all([run(s, [msg], f), run(s, [msg], f)])
  assert.equal(sent, 1)
  assert.deepEqual(await run(s), ["duplicate"])
  s.db.close()
})
void test("total dispatch cap survives distinct message IDs", async () => {
  const s = storage()
  for (let i = 0; i < 3; i++)
    assert.deepEqual(await run(s, [{ ...msg, id: "FIXTURE-CAP-" + i }]), ["acknowledged"])
  assert.deepEqual(await run(s, [{ ...msg, id: "FIXTURE-CAP-4" }]), ["budget_reached"])
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM recruitment_intake_delivery").get().n, 3)
  s.db.close()
})
void test("lost responses cannot cause automatic resend", async () => {
  const s = storage()
  assert.deepEqual(
    await run(s, [msg], async () => {
      throw new Error("lost")
    }),
    ["unknown_no_retry"],
  )
  assert.deepEqual(await run(s), ["duplicate"])
  s.db.close()
})
void test("invalid, redirect or oversized acknowledgement is not success", async () => {
  for (const f of [
    async () => new Response("{}"),
    async () => new Response("", { status: 302 }),
    async () => new Response("x".repeat(5000)),
  ]) {
    const s = storage()
    const r = await run(s, [msg], f)
    assert.notEqual(r[0], "acknowledged")
    s.db.close()
  }
})
void test("expired policy and wrong account never dispatch", async () => {
  const s = storage()
  assert.deepEqual(await run(s, [msg], ack, { ...policy, expiresAt: now }), [])
  assert.deepEqual(await run(s, [msg], ack, policy, "live", "654321@lid"), [])
  s.db.close()
})
