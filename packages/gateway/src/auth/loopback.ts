import { timingSafeEqual } from "node:crypto";
import { AuthResult } from "./result.ts";

/** One-shot OAuth callback listener; the caller supplies state and deadline and owns disposal. */
export async function listenForCallback(state: string, signal: AbortSignal, port = 0) {
  await using setup = new AsyncDisposableStack();

  const response = Promise.withResolvers<AuthResult<URL>>();
  let consumed = false;

  const abort = () =>
    response.resolve(
      AuthResult.failure(
        "cancelled",
        signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
          ? "OAuth login timed out. Run cmg login again."
          : "OAuth login was cancelled.",
      ),
    );

  signal.addEventListener("abort", abort, { once: true });
  setup.defer(() => {
    signal.removeEventListener("abort", abort);
    abort();
  });
  if (signal.aborted) abort();

  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  };

  try {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch(request, server) {
        const url = new URL(request.url);
        const expectedHost = `127.0.0.1:${server.port}`;
        if (
          request.method !== "GET" ||
          request.headers.get("host") !== expectedHost ||
          url.host !== expectedHost ||
          url.pathname !== "/oauth/callback"
        )
          return new Response("Not found", { status: 404, headers });

        const parameters = url.searchParams;
        const received = Buffer.from(parameters.get("state") ?? "");
        const expected = Buffer.from(state);
        if (
          signal.aborted ||
          parameters.getAll("state").length !== 1 ||
          received.length !== expected.length ||
          !timingSafeEqual(received, expected)
        )
          return new Response("Invalid authorization callback", { status: 400, headers });

        if (consumed)
          return new Response("Authorization response already received.", { status: 409, headers });

        consumed = true;
        response.resolve(AuthResult.success(url));

        return new Response("Authorization response received. You can close this tab.", {
          headers,
        });
      },
    });

    setup.defer(() => server.stop(true));
    const cleanup = setup.move();

    return AuthResult.success({
      redirectUri: new URL("/oauth/callback", server.url).href,
      response: response.promise,
      [Symbol.asyncDispose]: () => cleanup.disposeAsync(),
    });
  } catch (cause) {
    return AuthResult.failure(
      "unavailable",
      "Could not bind the OAuth loopback callback listener. Its registered port may already be in use.",
      cause,
    );
  }
}
