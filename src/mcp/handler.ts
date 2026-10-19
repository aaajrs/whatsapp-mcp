import { parseMediaPolicy } from "../whatsapp/media-policy"
import { createMcpHandler } from "agents/mcp/server"

import { createServer } from "./server"

export function serveMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  accountId: string,
): Promise<Response> {
  const account = env.ACCOUNT.getByName(accountId)
  const route = new URL(request.url).pathname
  return createMcpHandler(
    () => createServer(account, env.TIMEZONE, parseMediaPolicy(env.MEDIA_POLICY_JSON) !== null),
    { route },
  )(request, env, ctx)
}
