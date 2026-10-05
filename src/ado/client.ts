import type { z } from 'zod';
import type { Config } from '../config.js';
import { SafeError } from '../errors.js';
import type { AuthProvider } from './auth.js';

type Query = Record<string, string | number | boolean | undefined>;
export interface AdoResponse<T> {
  data: T;
  continuationToken?: string;
  productVersion?: string;
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** HTTP/JSON only: no MCP types, tool names, or protocol knowledge. */
export class AdoClient {
  readonly collectionUrl: string;

  constructor(
    private readonly config: Pick<
      Config,
      'serverUrl' | 'collection' | 'apiVersion' | 'timeoutMs'
    >,
    private readonly auth: AuthProvider,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.collectionUrl = `${config.serverUrl}/${encodeURIComponent(config.collection)}`;
  }

  url(path: readonly string[], query: Query = {}): URL {
    if (path.some((segment) => !segment || ['.', '..'].includes(segment))) {
      throw new SafeError(
        'INVALID_ARGUMENT',
        'Path identifiers must be non-empty and cannot be dot segments.',
      );
    }
    const url = new URL(
      `${this.collectionUrl}/${path.map(encodeURIComponent).join('/')}`,
    );
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    url.searchParams.set('api-version', this.config.apiVersion);
    return url;
  }

  async request<T>(
    path: readonly string[],
    schema: z.ZodType<T>,
    options: {
      method?: 'GET' | 'POST' | 'PATCH';
      query?: Query;
      body?: unknown;
    } = {},
  ): Promise<AdoResponse<T>> {
    const method = options.method ?? 'GET';
    const url = this.url(path, options.query);
    const signal = AbortSignal.timeout(this.config.timeoutMs);
    try {
      const response = await this.fetcher(url, {
        method,
        headers: {
          ...(await this.auth.getHeaders()),
          Accept: 'application/json',
          ...(options.body === undefined
            ? {}
            : { 'Content-Type': 'application/json' }),
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        redirect: 'manual',
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw httpError(response.status, method);
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/iu.test(contentType)) {
        await response.body?.cancel();
        throw new SafeError(
          'INVALID_RESPONSE',
          'Azure DevOps returned non-JSON content. Check the server/collection URL and authentication configuration.',
        );
      }
      const reader = response.body?.getReader();
      if (!reader)
        throw new SafeError(
          'INVALID_RESPONSE',
          'Azure DevOps returned an empty response.',
        );
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new SafeError(
              'RESPONSE_TOO_LARGE',
              'Azure DevOps response exceeds 8 MiB. Use a smaller page or narrower filter.',
            );
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      let data: T;
      try {
        data = schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        throw new SafeError(
          'INVALID_RESPONSE',
          'Azure DevOps returned an unexpected JSON response. Check the configured API version.',
        );
      }
      const continuationToken = response.headers.get('x-ms-continuationtoken');
      const productVersion = response.headers.get('x-tfs-product-version');
      return {
        data,
        ...(continuationToken ? { continuationToken } : {}),
        ...(productVersion ? { productVersion } : {}),
      };
    } catch (error) {
      if (error instanceof SafeError) {
        if (
          method !== 'GET' &&
          ['INVALID_RESPONSE', 'RESPONSE_TOO_LARGE'].includes(error.code)
        ) {
          throw new SafeError(
            error.code,
            `${error.message} A success response was received, but the write result could not be verified; inspect pull requests before retrying.`,
            error.status,
          );
        }
        throw error;
      }
      const uncertain =
        method === 'GET'
          ? ''
          : ' The write outcome may be unknown; inspect pull requests before retrying.';
      if (signal.aborted)
        throw new SafeError(
          'TIMEOUT',
          `Azure DevOps request timed out.${uncertain}`,
        );
      throw new SafeError(
        'CONNECTION_ERROR',
        `Cannot reach Azure DevOps. Check connectivity, TLS trust, and server configuration.${uncertain}`,
      );
    }
  }
}

function httpError(status: number, method: string): SafeError {
  const hints: Record<number, string> = {
    400: 'Azure DevOps rejected the request. Check the arguments and configured API version.',
    401: 'Authentication failed. Check the PAT and its expiry.',
    403: 'Access denied. Check PAT scopes and project/repository permissions.',
    404: 'Resource not found or not visible to this identity. Check collection, project, repository, and permissions.',
    409: 'The operation conflicts with existing state. A pull request may already exist for these branches.',
    429: 'Azure DevOps is rate limiting requests. Wait before trying again.',
  };
  const message =
    status >= 300 && status < 400
      ? 'Azure DevOps redirected the request. Configure its final URL; redirects are not followed.'
      : (hints[status] ?? `Azure DevOps request failed (HTTP ${status}).`);
  const uncertain =
    method !== 'GET' && status >= 500
      ? ' The write outcome may be unknown; inspect pull requests before retrying.'
      : '';
  return new SafeError(`HTTP_${status}`, message + uncertain, status);
}
