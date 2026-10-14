import { secrets } from "bun";
import { createHash } from "node:crypto";
import { z } from "zod";
import { type Configuration } from "../config.ts";
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

/** A scoped store, not a registry of other users' credentials. */
export type CredentialStore = {
  load(): Promise<AuthResult<Credentials | undefined>>;
  save(value: Credentials): Promise<AuthResult<void>>;
  clear(): Promise<AuthResult<void>>;
};

type SecretService = {
  get(key: { service: string; name: string }): Promise<string | null>;
  set(key: { service: string; name: string; value: string }): Promise<void>;
  delete(key: { service: string; name: string }): Promise<boolean>;
};

export function oauthConnection(upstream: Configuration["upstream"]): AuthResult<OAuthConnection> {
  if (upstream.transport !== "http" || upstream.auth === undefined || upstream.id === undefined) {
    return AuthResult.failure(
      "invalid",
      "This command requires an HTTP upstream with an id and OAuth authentication.",
    );
  }

  return AuthResult.success({
    id: upstream.id,
    url: new URL(upstream.url).href,
    ...(upstream.auth.scope === undefined ? {} : { scope: upstream.auth.scope }),
  });
}

export function credentialName(connection: OAuthConnection): string {
  return createHash("sha256")
    .update(connection.id + "\0" + connection.url)
    .digest("hex");
}

/** Uses the current OS user's credential service; no plaintext fallback. */
export function credentialStore(
  connection: OAuthConnection,
  service: SecretService = secrets,
): CredentialStore {
  const key = { service: "codemode-mcp-gateway", name: credentialName(connection) };

  return {
    async load() {
      let stored: string | null;
      try {
        stored = await service.get(key);
      } catch (cause) {
        return AuthResult.failure(
          "storage",
          "Could not read the OS credential store. Unlock or enable your credential service.",
          cause,
        );
      }

      if (stored === null) return AuthResult.success(undefined);

      let input: unknown;
      try {
        input = JSON.parse(stored);
      } catch (cause) {
        return AuthResult.failure(
          "invalid",
          "Stored OAuth credentials are invalid. Run cmg logout, then cmg login.",
          cause,
        );
      }

      const parsed = Credentials.safeParse(input);
      if (!parsed.success || parsed.data.upstreamUrl !== connection.url) {
        return AuthResult.failure(
          "invalid",
          "Stored OAuth credentials do not match this connection. Run cmg logout, then cmg login.",
        );
      }

      return AuthResult.success(parsed.data);
    },
    async save(value) {
      const parsed = Credentials.safeParse(value);
      if (!parsed.success || parsed.data.upstreamUrl !== connection.url) {
        return AuthResult.failure(
          "invalid",
          "Cannot store credentials for a different upstream connection.",
        );
      }

      try {
        await service.set({ ...key, value: JSON.stringify(parsed.data) });
      } catch (cause) {
        return AuthResult.failure(
          "storage",
          "Could not save OAuth credentials in the OS credential store. Authorization may need to be repeated.",
          cause,
        );
      }

      return AuthResult.success(undefined);
    },
    async clear() {
      try {
        await service.delete(key);
      } catch (cause) {
        return AuthResult.failure(
          "storage",
          "Could not remove OAuth credentials from the OS credential store.",
          cause,
        );
      }

      return AuthResult.success(undefined);
    },
  };
}
