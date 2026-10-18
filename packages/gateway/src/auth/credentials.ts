import { createHash } from "node:crypto";
import { z } from "zod";
import { type ServerConfiguration } from "../config.ts";
import { AuthResult } from "./result.ts";

const client = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1).optional(),
  client_secret_expires_at: z.number().int().nonnegative().optional(),
});

export const Tokens = z.object({
  access_token: z.string().min(1),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().nonnegative().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});

export const Credentials = z.strictObject({
  version: z.literal(1),
  upstreamUrl: z.url(),
  issuer: z.url(),
  resource: z.url().nullable(),
  redirectUri: z.url(),
  client,
  authorization: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("required") }),
    z.strictObject({
      status: z.literal("authorized"),
      tokens: Tokens,
      receivedAt: z.number().int().nonnegative(),
    }),
  ]),
});

export type Credentials = z.infer<typeof Credentials>;

/** Private change marker for observing login/logout without logging or retaining token values. */
export function credentialVersion(record: Credentials | undefined): string {
  return createHash("sha256")
    .update(JSON.stringify(record ?? null))
    .digest("hex");
}

/** Normalize both exchanged and refreshed tokens before persistence. */
export function withTokens(record: Credentials, input: unknown) {
  const parsed = Tokens.safeParse(input);
  if (!parsed.success) {
    return AuthResult.failure(
      "invalid",
      "The upstream returned unsupported or invalid OAuth tokens.",
    );
  }

  return AuthResult.success({
    ...record,
    authorization: { status: "authorized", tokens: parsed.data, receivedAt: Date.now() },
  } satisfies Credentials);
}

export type OAuthConnection = {
  id: string;
  url: string;
  scope?: string;
};

/**
 * A scoped store, not a registry of other users' credentials. Saves replace complete
 * snapshots; concurrent readers must not observe partially updated grants.
 */
export type CredentialStore = {
  load(): Promise<AuthResult<Credentials | undefined>>;
  save(value: Credentials): Promise<AuthResult<void>>;
  clear(): Promise<AuthResult<void>>;
};

export function oauthConnection(
  name: string,
  upstream: ServerConfiguration,
): AuthResult<OAuthConnection> {
  if (upstream.type !== "remote" || !upstream.oauth) {
    return AuthResult.failure(
      "invalid",
      "This command requires a remote server with OAuth authentication.",
    );
  }

  return AuthResult.success({
    id: name,
    url: new URL(upstream.url).href,
    ...(upstream.oauth.scope === undefined ? {} : { scope: upstream.oauth.scope }),
  });
}

export function credentialName(connection: OAuthConnection): string {
  return createHash("sha256")
    .update(connection.id + "\0" + new URL(connection.url).href)
    .digest("hex");
}
