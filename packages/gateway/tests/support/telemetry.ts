import { MetricReader, type ResourceMetrics } from "@opentelemetry/sdk-metrics";

/** Pull real SDK measurements without timers or a collector. */
export class Metrics extends MetricReader {
  protected onShutdown(): Promise<void> {
    return Promise.resolve();
  }
  protected onForceFlush(): Promise<void> {
    return Promise.resolve();
  }

  async snapshot(): Promise<ResourceMetrics> {
    const collected = await this.collect();
    if (collected.errors.length > 0)
      throw new AggregateError(collected.errors, "Metric collection failed");

    return collected.resourceMetrics;
  }
}

export function metric(snapshot: ResourceMetrics, name: string) {
  const result = snapshot.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .find((metric) => metric.descriptor.name === name);

  if (result === undefined) throw new Error(`Missing metric ${name}`);

  return result;
}
