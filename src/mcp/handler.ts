import { parseMediaPolicy } from "../whatsapp/media-policy"
import { createMcpHandler } from "agents/mcp/server"
import type { OAuthResourceAuth } from "@cloudflare/workers-oauth-provider"
import { z } from "zod"
import { recruitmentEventAuthority } from "../auth/oauth"
import { EventError, referralDefinition } from "./recruitment-events"

import { createServer } from "./server"

export async function serveMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  accountId: string,
  auth?: OAuthResourceAuth,
): Promise<Response> {
  const account = env.ACCOUNT.getByName(accountId)
  const route = new URL(request.url).pathname
  // The current SDK strips draft event capabilities from server/discover. Handle
  // the four extension methods here, after exactly the tools' authentication.
  const decoded =
    request.method === "POST"
      ? await request
          .clone()
          .json()
          .catch(() => null)
      : null
  const parsed = z.record(z.string(), z.unknown()).safeParse(decoded)
  const body = parsed.success ? parsed.data : null
  const method = body?.method
  const eventMethod =
    body &&
    typeof method === "string" &&
    ["server/discover", "events/list", "events/subscribe", "events/unsubscribe"].includes(method)
  if (eventMethod && accountId === "personal") {
    const id = body.id ?? null
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result })
    if (body.jsonrpc !== "2.0" || !(typeof body.id === "string" || Number.isSafeInteger(body.id)))
      return Response.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "Invalid request" },
      })
    try {
      if (method === "server/discover")
        return reply({
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {}, events: {} },
        })
      if (method === "events/list") {
        const p = z
          .object({ cursor: z.null().optional(), _meta: z.unknown().optional() })
          .strict()
          .safeParse(body.params ?? {})
        if (!p.success) throw new EventError(-32602, "invalid_cursor_or_params")
        return reply({ events: [referralDefinition] })
      }
      const authority = await recruitmentEventAuthority(request, env, accountId, auth)
      const response = await account.recruitmentEventRequest(method, authority, body.params)
      if (!response.ok)
        throw new EventError(response.code ?? -32015, response.reason ?? "request_failed")
      return reply(response.result)
    } catch (error) {
      return Response.json({
        jsonrpc: "2.0",
        id,
        error: {
          code: error instanceof EventError ? error.code : -32015,
          message: "Event subscription unavailable",
          data: { reason: error instanceof EventError ? error.reason : "request_failed" },
        },
      })
    }
  }
  return createMcpHandler(
    () => {
      const server = createServer(
        account,
        env.TIMEZONE,
        parseMediaPolicy(env.MEDIA_POLICY_JSON) !== null,
      )
      if (accountId === "personal") {
        for (const operation of ["status", "test"] as const)
          server.registerTool(
            operation === "status"
              ? "recruitment_notification_status"
              : "test_recruitment_notification",
            {
              title:
                operation === "status"
                  ? "Recruitment notification status"
                  : "Test Rayan referral notification",
              description:
                operation === "status"
                  ? "Read subscription and delivery counters without exposing callback URLs, signing secrets, or message content."
                  : "Emit one synthetic referral notification to the already verified Rayan subscription. No WhatsApp message, candidate contact, model API, or n8n execution. Idempotent once per subscription.",
              inputSchema: z.object({}),
              annotations: {
                readOnlyHint: operation === "status",
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: operation === "test",
              },
            },
            async () => {
              const authority = await recruitmentEventAuthority(request, env, accountId, auth)
              const result = await account.recruitmentEventRequest(operation, authority, {})
              return {
                content: [
                  { type: "text", text: JSON.stringify(result.ok ? result.result : result) },
                ],
                isError: !result.ok,
              }
            },
          )
      }
      return server
    },
    { route },
  )(request, env, ctx)
}
