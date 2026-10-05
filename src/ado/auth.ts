export interface AuthProvider {
  getHeaders(): Promise<Record<string, string>>;
}

export class PatAuthProvider implements AuthProvider {
  readonly #authorization: string;

  constructor(token: string) {
    this.#authorization = `Basic ${Buffer.from(`:${token}`, 'utf8').toString('base64')}`;
  }

  async getHeaders(): Promise<Record<string, string>> {
    return { Authorization: this.#authorization };
  }
}

/** Defence in depth if an upstream field happens to echo credentials. */
export function createSecretRedactor(token: string): (text: string) => string {
  const encoded = Buffer.from(`:${token}`, 'utf8').toString('base64');
  const secrets = [token, encoded, encodeURIComponent(token)]
    .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)])
    .sort((a, b) => b.length - a.length);
  return (text) =>
    secrets.reduce(
      (value, secret) => value.split(secret).join('[REDACTED]'),
      text,
    );
}
