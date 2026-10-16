import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** The private service key never crosses HTTP; native bearer tokens belong to one instance. */
export class ServiceAuthentication {
  constructor(private readonly key: string) {}

  static bearer(key: string, instanceId: string): string {
    return createHmac("sha256", key)
      .update("cmg bearer v2\0" + instanceId)
      .digest("base64url");
  }

  request(url: URL): string {
    const attempt = `${Date.now()}.${randomBytes(32).toString("base64url")}`;

    return `CMG-Status ${attempt}.${this.sign("request", url, attempt)}`;
  }

  accepts(url: URL, authorization: string | null): boolean {
    const match = authorization?.match(
      /^CMG-Status (\d{13}\.[A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/,
    );

    if (match?.[1] === undefined || match[2] === undefined) return false;

    const issuedAt = Number(match[1].split(".")[0]);
    if (Math.abs(Date.now() - issuedAt) > 30_000) return false;

    return equal(match[2], this.sign("request", url, match[1]));
  }

  response(url: URL, authorization: string, body: string): string {
    return this.sign("response", url, authorization + "\0" + body);
  }

  verifies(url: URL, authorization: string, body: string, signature: string | null): boolean {
    return signature !== null && equal(signature, this.response(url, authorization, body));
  }

  private sign(kind: "request" | "response", url: URL, value: string): string {
    return createHmac("sha256", this.key)
      .update(`cmg status ${kind} v2\0${url.href}\0${value}`)
      .digest("base64url");
  }
}

function equal(submitted: string, expected: string): boolean {
  return (
    /^[A-Za-z0-9_-]{43}$/.test(submitted) &&
    timingSafeEqual(Buffer.from(submitted), Buffer.from(expected))
  );
}
