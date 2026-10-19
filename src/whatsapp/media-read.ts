// Policy is loaded only from the optional private Worker runtime binding.
export interface MediaPolicy {
  groupJid: string
  ownerJids: readonly string[]
  maxBytes: number
  notBefore: number
}

type Content = Record<string, unknown>
export interface MediaRecord {
  chatJid: string
  id: string
  fromMe: boolean
  senderJid: string | null
  sentAt: number
  deleted: boolean
}
export interface MediaEnvelope {
  key?: {
    remoteJid?: string | null
    id?: string | null
    fromMe?: boolean | null
    participant?: string | null
  }
  participant?: string | null
  ephemeralStartTimestamp?: unknown
  ephemeralDuration?: unknown
  ephemeralOffToOn?: unknown
  ephemeralOutOfSync?: unknown
  clearMedia?: unknown
  revokeMessageTimestamp?: unknown
  messageStubType?: unknown
  message?: object | null
}
export interface MediaResult {
  chat: string
  message_id: string
  mimetype: "image/jpeg" | "image/png" | "application/pdf"
  data: Uint8Array
  source: "downloaded_attachment"
}

function fail(code: string): never {
  throw new Error(code)
}
const object = (x: unknown): x is Content => x !== null && typeof x === "object"

// Dependency injection lets safety tests run without WhatsApp or private files.
export async function readScopedMedia(
  policy: MediaPolicy | null,
  requested: { chat: string; message_id: string },
  record: MediaRecord | null,
  raw: MediaEnvelope | null,
  download: (directPath: string, maxEncryptedBytes: number) => Promise<Uint8Array>,
  current: () => MediaRecord | null,
): Promise<MediaResult> {
  if (!policy) fail("MEDIA_DISABLED")
  if (
    !Number.isSafeInteger(policy.maxBytes) ||
    policy.maxBytes < 1 ||
    policy.maxBytes > 5 * 1024 * 1024 ||
    !Number.isFinite(policy.notBefore)
  )
    fail("INVALID_POLICY")
  const authorized = (item: MediaRecord | null) => {
    if (!item || item.deleted) fail("MEDIA_UNAVAILABLE")
    if (
      requested.chat !== policy.groupJid ||
      item.chatJid !== requested.chat ||
      item.id !== requested.message_id
    )
      fail("OUT_OF_SCOPE")
    if (!item.fromMe || (item.senderJid !== null && !policy.ownerJids.includes(item.senderJid)))
      fail("NOT_OWNER")
    if (!Number.isFinite(item.sentAt) || item.sentAt < policy.notBefore) fail("BEFORE_ACTIVATION")
  }
  authorized(record)
  if (
    !raw?.key ||
    raw.key.remoteJid !== requested.chat ||
    raw.key.id !== requested.message_id ||
    raw.key.fromMe !== true
  )
    fail("IDENTITY_MISMATCH")
  for (const author of [raw.key.participant, raw.participant]) {
    if (author && !policy.ownerJids.includes(author)) fail("IDENTITY_MISMATCH")
  }
  // Check the outer WebMessageInfo, not only the nested media context. These
  // fields survive archive protobuf encoding independently of contextInfo.
  // Presence is conservative: even explicit zero/false metadata is ambiguous.
  const present = (field: keyof MediaEnvelope) =>
    Object.prototype.hasOwnProperty.call(raw, field) && raw[field] != null
  if (
    present("ephemeralStartTimestamp") ||
    present("ephemeralDuration") ||
    present("ephemeralOffToOn") ||
    present("ephemeralOutOfSync")
  )
    fail("EPHEMERAL_MEDIA")
  if (present("clearMedia") || present("revokeMessageTimestamp") || present("messageStubType"))
    fail("MEDIA_UNAVAILABLE")
  const content = raw.message
  if (!object(content)) fail("MEDIA_UNAVAILABLE")
  // Fail closed on wrappers, including view-once, ephemeral, edits and albums.
  const kinds = Object.keys(content).filter((k) => content[k] != null)
  if (kinds.length !== 1 || !["imageMessage", "documentMessage"].includes(kinds[0]!))
    fail("UNSUPPORTED_MESSAGE")
  const media = content[kinds[0]!]
  if (!object(media)) fail("MEDIA_UNAVAILABLE")
  if (media.viewOnce === true) fail("VIEW_ONCE")
  const context = media.contextInfo
  if (object(context) && (context.expiration != null || context.ephemeralSettingTimestamp != null))
    fail("EPHEMERAL_MEDIA")
  const mime = media.mimetype
  if (mime !== "image/jpeg" && mime !== "image/png" && mime !== "application/pdf")
    fail("UNSUPPORTED_TYPE")
  if ((kinds[0] === "imageMessage") !== mime.startsWith("image/")) fail("MIME_MISMATCH")
  function hasToNumber(value: unknown): value is { toNumber(): unknown } {
    return object(value) && typeof value.toNumber === "function"
  }
  const candidateLength = hasToNumber(media.fileLength)
    ? media.fileLength.toNumber()
    : media.fileLength
  const length = typeof candidateLength === "number" ? candidateLength : NaN
  if (!Number.isSafeInteger(length) || length <= 0 || length > policy.maxBytes)
    fail("MEDIA_SIZE_LIMIT")
  // No URLs or cryptographic fields leave the owning account.
  if (
    typeof media.directPath !== "string" ||
    !media.directPath ||
    !(media.mediaKey instanceof Uint8Array) ||
    !(media.fileSha256 instanceof Uint8Array) ||
    !(media.fileEncSha256 instanceof Uint8Array)
  )
    fail("MISSING_DOWNLOAD_METADATA")
  let data: Uint8Array
  try {
    data = await download(media.directPath, policy.maxBytes + 26)
  } catch {
    fail("DOWNLOAD_FAILED")
  }
  if (
    !(data instanceof Uint8Array) ||
    data.byteLength !== length ||
    data.byteLength > policy.maxBytes
  )
    fail("DOWNLOAD_SIZE_MISMATCH")
  const starts = (bytes: number[]) => bytes.every((byte, i) => data[i] === byte)
  const valid =
    mime === "image/jpeg"
      ? starts([255, 216, 255])
      : mime === "image/png"
        ? starts([137, 80, 78, 71, 13, 10, 26, 10])
        : starts([37, 80, 68, 70, 45])
  if (!valid) fail("CONTENT_TYPE_MISMATCH")
  authorized(current()) // Catch revocation while download was in progress.
  return {
    chat: requested.chat,
    message_id: requested.message_id,
    mimetype: mime,
    data,
    source: "downloaded_attachment",
  }
}
