/** Bun's fetch boundary includes preconnect even when a test only exercises requests. */
export function fetchImplementation(
  handler: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, { preconnect: () => {} });
}
