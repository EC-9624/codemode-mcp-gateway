/** Only application-owned public messages may be printed by the CLI. Causes stay private. */
export class GatewayError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GatewayError";
  }
}
