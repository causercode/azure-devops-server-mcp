import type { AuthSettings } from '../config.js';
import { NegotiateAuthProvider } from './negotiate.js';

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

export function createAuthProvider(auth: AuthSettings): AuthProvider {
  return auth.authType === 'pat'
    ? new PatAuthProvider(auth.token)
    : new NegotiateAuthProvider(auth.servicePrincipal);
}

/** Static secrets to redact; Negotiate tokens are per-request tickets, not stored secrets. */
export function authSecrets(auth: AuthSettings): string[] {
  return auth.authType === 'pat' ? [auth.token] : [];
}

/** Defence in depth if an upstream field happens to echo credentials. */
export function createSecretRedactor(
  tokens: string | readonly string[],
): (text: string) => string {
  const secrets = (typeof tokens === 'string' ? [tokens] : tokens)
    .flatMap((token) => [
      token,
      Buffer.from(`:${token}`, 'utf8').toString('base64'),
      encodeURIComponent(token),
    ])
    .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)])
    .sort((a, b) => b.length - a.length);
  return (text) =>
    secrets.reduce(
      (value, secret) => value.split(secret).join('[REDACTED]'),
      text,
    );
}
