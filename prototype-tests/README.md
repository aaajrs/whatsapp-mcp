# Offline media-read prototype

This change is not deployed and the private MEDIA_POLICY_JSON binding is absent by default (disabled). It targets the verified user repository https://github.com/aaajrs/whatsapp-mcp at commit 6459a7c1b062aa8ba46735f5807b61f2ca623dd8. The active Cloudflare deployment's commit equivalence still needs verification.

## What it implements
- A narrow, disabled-by-default MCP image/PDF byte-reading tool wired into the account Durable Object.
- Server-side group, owner, message, activation-time, deletion and raw-envelope checks.
- Rejects wrappers, view-once and ephemeral media rather than silently flattening them.
- Size, declared MIME and header-signature checks; error redaction; post-download revocation check; one in-flight download per account.
- Uses the existing account socket's downloadMedia(raw, 'buffer', {}) API, verified present in the published @oxidezap/baileyrs 0.3.10 package. This does not require a new WhatsApp pairing.
- Actual image bytes returned as MCP image content; PDF bytes as embedded MCP resource. No OCR provider is contacted by this code.

## Tests and limits
Run `bun test`. The media-specific tests inject synthetic bytes and a fake download, never real messages or credentials. These establish boundary/transport behavior, not live download, full image validity, PDF parsing, OCR accuracy, or n8n multimedia compatibility.

Before activation: confirm the deployed repository/version; review the patch; get explicit scoped access and processing approval; configure the private MEDIA_POLICY_JSON Worker binding with only the designated group and verified owner IDs plus an activation timestamp; test staging with real nonsensitive synthetic image and PDF files. No archive-wide capability should be enabled.

Implemented locally: bounded encrypted-response streaming with a real fetch AbortController, actual byte counting, retry/cumulative budgets, strict host/path and redirect checks. Both nested context and archived WebMessageInfo lifecycle metadata fail closed, including expiration, clearMedia, revoke timestamps and stubs. Actual pinned-protobuf archive roundtrips test these checks. Remaining production gates: workerd and enabled lifecycle validation; PDF page/parser limits; full decoder validation; n8n end-to-end multimodal ingestion. A socket startup/reconnect wait outside fetch is not cancelled by the HTTP timer; the account lock deliberately stays held until the underlying operation settles, rather than unsafe release allowing concurrent work. A timeout implemented as Promise.race alone would not cancel the underlying download and is deliberately not presented as a safe resource bound.

The policy cap defaults to no value because the capability is disabled. Runtime binding validation accepts at most 2 MiB. All content is untrusted data; it cannot authorize actions or bypass the agent's Notion approval controls.


## Exact path evidence and rollback
The pinned bridge v0.25.0 (479eec58f5071940f30858cbcc79bdbce2f75401) sends DownloadParams::encrypted(direct_path,...) to pinned core 6f7a62296242f5dab8967431bd1c6528c1339efe. Core wacore/src/download.rs constructs each CDN URL from that unchanged direct_path plus query parameters. The scoped callback matches the parsed pathname, so host failover cannot silently fall through merely by changing host; an unapproved host on that path is rejected. This is source evidence, not a live-runtime assertion.

No deployment exists to roll back. Local rollback: apply the patch in reverse against its own resulting tree. Before any future deployment, record the current Worker version and corresponding commit, keep the old artifact, and verify the rollback route. Disable by removing MEDIA_POLICY_JSON or setting it to null and redeploying the reviewed artifact; do not delete account storage or relink WhatsApp. Disabling hides the tool and preserves the original socket construction path. If a deployed change misbehaves, restore the recorded prior Worker version rather than changing credentials or clearing the archive.

Core retry logs can contain signed URLs. The enabled runtime logger sink redacts URLs and media-key/download-failure diagnostics before output; a synthetic regression test covers this. Disabled mode preserves original socket construction. The local Wrangler dry-run successfully bundles the disabled artifact; live workerd behavior is still untested.

## Persistent attempt budget
The enabled account reserves a SQLite-backed download attempt after scope/metadata validation and before network I/O. Maximum 30 attempts per one-hour window, at least 10 seconds apart, shared across all authenticated clients. Failed downloads count; denied scope/metadata requests do not. Atomic transactionSync prevents concurrent reservations; state survives Worker/DO restarts. Invalid persisted state or clock rollback fails closed. Disabled policy never creates the table. The workerd budget test is opt-in (`RUN_OFFLINE_WORKERD=1 node --test prototype-tests/media-budget-workerd.test.mjs`) and now sets cf:false; review the offline transport configuration before running. An earlier local run passed SQLite concurrency/restart coverage. Standard Bun runs skip this test so they do not implicitly start Miniflare. No production storage is touched.

Node enabled-factory lifecycle integration passes with the actual pinned JS core and stub bridge/client/network; the real Worker/WASM lifecycle remains unverified. Miniflare has a separate default external cf.json metadata retrieval, so offline runs must explicitly disable it; no production-readiness claim. The separate budget harness previously passed, but its updated explicitly offline cf:false configuration has not been rerun.

## Private runtime policy
Do not hardcode group/owner identifiers or cutoff in the public repository. MEDIA_POLICY_JSON is an optional operator-managed Worker environment binding, parsed without logging values. Missing, malformed or unexpected fields fail closed: tool hidden, account denies reads, socket uses original path. Fill only the approved group/owner aliases, 2 MiB cap and fixed activation Unix-seconds timestamp privately. Preserve dashboard variables on deployment with --keep-vars; never commit the filled JSON or pass it in public CI logs.
