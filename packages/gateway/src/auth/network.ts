import { dns } from "bun";
import { BlockList, isIP } from "node:net";
import { AuthResult } from "./result.ts";

const reserved = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  reserved.addSubnet(address, prefix, "ipv4");

reserved.addSubnet("2001::", 23, "ipv6");
reserved.addSubnet("2001:db8::", 32, "ipv6");
reserved.addSubnet("2002::", 16, "ipv6");
reserved.addSubnet("3fff::", 20, "ipv6");
const globalIPv6 = new BlockList();
globalIPv6.addSubnet("2000::", 3, "ipv6");
const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

type OAuthDeadline = { signal: AbortSignal; cancellation: AbortSignal };

/** DNS validation and HTTP share one budget without losing the source of cancellation. */
export function oauthDeadline(signal: AbortSignal, requestSignal?: AbortSignal): OAuthDeadline {
  const cancellation =
    requestSignal === undefined ? signal : AbortSignal.any([signal, requestSignal]);

  return {
    cancellation,
    signal: AbortSignal.any([cancellation, AbortSignal.timeout(15_000)]),
  };
}

/** Validate delegated destinations and pin the approved DNS result for the actual connection. */
export async function oauthEndpoint(
  input: string | URL,
  upstream: string,
  deadline: OAuthDeadline,
) {
  const url = URL.parse(String(input));
  const configured = new URL(upstream);
  const configuredHost = host(configured);
  const development = local(configuredHost);
  if (
    url === null ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && development && local(host(url))))
  )
    return AuthResult.failure(
      "invalid",
      "OAuth endpoints must use HTTPS without embedded credentials or fragments; loopback HTTP requires an explicitly configured loopback upstream.",
    );

  const hostname = host(url);
  const family = isIP(hostname);

  const privateOrigin =
    isIP(configuredHost) !== 0 &&
    !publicAddress(configuredHost) &&
    url.origin === configured.origin;

  let addresses;
  try {
    deadline.signal.throwIfAborted();
    addresses =
      family === 0 ? await resolve(hostname, deadline.signal) : [{ address: hostname, family }];
    deadline.signal.throwIfAborted();
  } catch (cause) {
    if (deadline.cancellation.aborted)
      return AuthResult.failure("cancelled", "OAuth operation was cancelled.", cause);

    return AuthResult.failure(
      "unavailable",
      deadline.signal.aborted
        ? "OAuth network operation timed out."
        : "Could not resolve an OAuth endpoint.",
      cause,
    );
  }

  const selected = addresses.find(({ family }) => family === 4) ?? addresses[0];
  if (selected === undefined)
    return AuthResult.failure("unavailable", "The OAuth endpoint did not resolve to an address.");

  if (
    !addresses.every(
      ({ address }) =>
        publicAddress(address) || privateOrigin || (development && isLoopback(address)),
    )
  )
    return AuthResult.failure(
      "invalid",
      "OAuth discovery cannot access private or reserved destinations unless explicitly trusted by the configured upstream.",
    );

  const pinned = new URL(url);
  pinned.hostname = selected.family === 6 ? `[${selected.address}]` : selected.address;

  return AuthResult.success({ url: pinned, host: url.host, hostname });
}

function host(url: URL): string {
  return url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
}

function local(hostname: string): boolean {
  return hostname === "localhost" || isLoopback(hostname);
}

function isLoopback(address: string): boolean {
  const family = isIP(address);

  return family !== 0 && loopback.check(address, family === 6 ? "ipv6" : "ipv4");
}

function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;

  if (family === 6 && !globalIPv6.check(address, "ipv6")) return false;

  return !reserved.check(address, family === 6 ? "ipv6" : "ipv4");
}

/** DNS itself cannot be cancelled; a late answer must not resume a cancelled auth request. */
async function resolve(hostname: string, signal: AbortSignal) {
  const cancelled = Promise.withResolvers<never>();
  const abort = () => cancelled.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();

  try {
    return await Promise.race([dns.lookup(hostname, { backend: "system" }), cancelled.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
