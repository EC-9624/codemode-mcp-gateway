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
  // `defer` registers cleanup now; it runs when the stack is disposed.
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/DisposableStack/defer
  cleanup.defer(() => {
    source.off(event, listener);
  });
  source.on(event, listener);
}
