type EventSource = {
  on(event: string, listener: (arg: unknown) => void): unknown;
  off(event: string, listener: (arg: unknown) => void): unknown;
};

/** Registers removal before adding, so partial listener setup also unwinds. */
export function listen(
  cleanup: { defer(onDispose: () => void): void },
  source: EventSource,
  event: string,
  listener: (arg: unknown) => void,
): void {
  cleanup.defer(() => {
    source.off(event, listener);
  });
  source.on(event, listener);
}
