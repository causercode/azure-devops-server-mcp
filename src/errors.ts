/** Only deliberately authored messages from this class may reach MCP clients. */
export class SafeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SafeError';
  }
}
