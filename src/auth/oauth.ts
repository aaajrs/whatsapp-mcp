// Each account is its own authorization server, with issuer /accounts/{id} and
// resource /accounts/{id}/mcp, so a token for one account does not open another.
// Claude wants the resource to be the exact URL the user pasted, and we only know
// the host on the first request, so the servers are built then.
import {
  OAuthAuthorizationServer,
  OAuthResourceServer,
  insufficientScope,
  type OAuthResourceAuth,
} from "@cloudflare/workers-oauth-provider"

import { serveMcp } from "../mcp/handler"
import { type AuthConfig, allowsApiKey } from "./config"
import { sameSecret } from "./secret"
import { readAuthConfig } from "./config"
import { eventDigest, type EventAuthority } from "../mcp/recruitment-events"

export const SCOPE = "whatsapp"

interface AccessProps {
  accountId: string
}

export interface AccountOAuth {
  authorization: OAuthAuthorizationServer<Env>
  resource: OAuthResourceServer<Env, AccessProps>
}

// Account ids come from the URL, so the cache needs a cap.
const MAX_CACHED = 64
const cache = new Map<string, AccountOAuth>()

export function accountOAuth(origin: string, accountId: string, config: AuthConfig): AccountOAuth {
  const key = `${origin} ${accountId}`
  let entry = cache.get(key)
  if (!entry) {
    if (cache.size >= MAX_CACHED) cache.clear()
    entry = build(origin, accountId, config)
    cache.set(key, entry)
  }
  return entry
}

function build(origin: string, accountId: string, config: AuthConfig): AccountOAuth {
  const issuer = `${origin}/accounts/${accountId}`
  const resourceUrl = `${issuer}/mcp`

  const authorization = new OAuthAuthorizationServer<Env>({
    issuer,
    resources: [resourceUrl],
    clientIdMetadataDocumentEnabled: true,
    clientRegistrationEndpoint: `/accounts/${accountId}/oauth/register`,
    scopesSupported: [SCOPE, "offline_access"],
    // A connector expires after 30 days without use.
    refreshTokenIdleTTL: 30 * 24 * 60 * 60,
  })

  const resource = new OAuthResourceServer<Env, AccessProps>({
    resourceMetadata: {
      resource: resourceUrl,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      resource_name: `WhatsApp (${accountId})`,
    },
    requiredScopes: [SCOPE],
    validateToken: (env) => async (audience, token) => {
      if (allowsApiKey(config.mode) && (await sameSecret(token, config.secret))) {
        return { props: { accountId }, audience, scope: [SCOPE] }
      }
      return authorization.validateToken<AccessProps>(audience, token, env)
    },
    handler: {
      fetch(request, env, ctx) {
        if (!ctx.auth.scope.includes(SCOPE)) return insufficientScope(ctx.auth, [SCOPE])
        return serveMcp(request, env, ctx, accountId, ctx.auth)
      },
    },
  })

  return { authorization, resource }
}

// Store a revocable grant reference, never a bearer or refresh token, with an event subscription.
export async function recruitmentEventAuthority(
  request: Request,
  env: Env,
  accountId: string,
  auth?: OAuthResourceAuth,
): Promise<EventAuthority> {
  const config = readAuthConfig(env)
  if (typeof config === "string") throw new Error("AUTH_UNAVAILABLE")
  const origin = new URL(request.url).origin
  if (auth?.userId && auth.clientId) {
    const api = accountOAuth(origin, accountId, config).authorization.getOAuthApi(env)
    const token = await api.unwrapToken<AccessProps>(auth.token)
    if (
      !token ||
      token.grant.props.accountId !== accountId ||
      token.userId !== auth.userId ||
      token.grant.clientId !== auth.clientId
    )
      throw new Error("AUTH_UNAVAILABLE")
    return {
      kind: "oauth",
      origin,
      accountId,
      userId: token.userId,
      clientId: token.grant.clientId,
      grantId: token.grantId,
      principal: await eventDigest(
        JSON.stringify([accountId, token.userId, token.grant.clientId, token.grantId]),
      ),
    }
  }
  // This path is reached only after the existing bearer authentication has succeeded.
  const keyHash = await eventDigest(config.secret)
  return {
    kind: "api_key",
    origin,
    accountId,
    keyHash,
    principal: await eventDigest(accountId + ":" + keyHash),
  }
}

export async function recruitmentEventAccess(
  env: Env,
  authority: EventAuthority,
): Promise<boolean> {
  const config = readAuthConfig(env)
  if (typeof config === "string" || authority.accountId !== "personal") return false
  if (authority.kind === "api_key")
    return allowsApiKey(config.mode) && authority.keyHash === (await eventDigest(config.secret))
  if (config.mode === "api_key" || !authority.userId || !authority.clientId || !authority.grantId)
    return false
  const api = accountOAuth(authority.origin, authority.accountId, config).authorization.getOAuthApi(
    env,
  )
  const grants = await api.listUserGrants(authority.userId, { limit: 100 })
  const resource = authority.origin + "/accounts/" + authority.accountId + "/mcp"
  return grants.items.some(
    (g) =>
      g.id === authority.grantId &&
      g.clientId === authority.clientId &&
      g.scope.includes(SCOPE) &&
      (!g.expiresAt || g.expiresAt > Date.now() / 1000) &&
      (g.resource === resource || (Array.isArray(g.resource) && g.resource.includes(resource))),
  )
}
