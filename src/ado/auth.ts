import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthSettings } from '../config.js';
import { NegotiateAuthProvider } from './negotiate.js';

export interface AuthProvider {
  getHeaders(signal?: AbortSignal): Promise<Record<string, string>>;
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

/** Static secrets; per-request authorization is captured separately. */
export function authSecrets(auth: AuthSettings): string[] {
  return auth.authType === 'pat' ? [auth.token] : [];
}

/** Defence in depth if an upstream field happens to echo credentials. */
export function createSecretRedactor(
  tokens: string | readonly string[],
): (text: string) => string {
  const secrets = (typeof tokens === 'string' ? [tokens] : tokens)
    .filter((token) => token.length > 0)
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

/** Keep generated credentials for one tool call, including concurrent REST requests. */
export class ToolSecretRedactor {
  readonly #scope = new AsyncLocalStorage<Set<string>>();
  readonly #staticRedact: (text: string) => string;

  constructor(secrets: readonly string[]) {
    this.#staticRedact = createSecretRedactor(secrets);
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.#scope.run(new Set(), operation);
  }

  capture(headers: Record<string, string>): void {
    const secrets = this.#scope.getStore();
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() !== 'authorization' || !value) continue;
      secrets?.add(value);
      const credential = value.replace(/^\S+\s+/u, '');
      if (credential) secrets?.add(credential);
    }
  }

  redact(text: string): string {
    return createSecretRedactor([...(this.#scope.getStore() ?? [])])(
      this.#staticRedact(text),
    );
  }
}
