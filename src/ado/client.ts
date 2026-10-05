import { z } from 'zod';
import type { Config } from '../config.js';
import { SafeError } from '../errors.js';
import type { AuthProvider } from './auth.js';
import { endpointVersion, type Endpoint } from './api-version.js';

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

  async requestText(
    path: readonly string[],
    options: { query?: Query; maxBytes?: number; endpoint?: Endpoint } = {},
  ): Promise<AdoResponse<string>> {
    const maxBytes = options.maxBytes ?? 256 * 1024;
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 1024 * 1024
    )
      throw new SafeError(
        'INVALID_ARGUMENT',
        'Text response limit must be between 1 byte and 1 MiB.',
      );
    return this.request(path, z.string(), {
      ...options,
      responseType: 'text',
      maxBytes,
    });
  }

  async request<T>(
    path: readonly string[],
    schema: z.ZodType<T>,
    options: {
      method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
      query?: Query;
      body?: unknown;
      endpoint?: Endpoint;
      contentType?: 'application/json' | 'application/json-patch+json';
      readOnly?: boolean;
      allowEmpty?: boolean;
      recovery?: string;
      responseType?: 'text';
      maxBytes?: number;
    } = {},
  ): Promise<AdoResponse<T>> {
    const method = options.method ?? 'GET';
    const writes = method !== 'GET' && !options.readOnly;
    const recovery =
      options.recovery ?? 'inspect pull requests before retrying';
    const url = this.url(path, options.query);
    if (options.endpoint) {
      const version = endpointVersion(this.config.apiVersion, options.endpoint);
      if (!version)
        throw new SafeError(
          'UNSUPPORTED_API_VERSION',
          'Phase 2 endpoints require configured REST 7.0 or 7.1. Earlier versions retain only the original v0.1 tools.',
        );
      url.searchParams.set('api-version', version);
    }
    const signal = AbortSignal.timeout(this.config.timeoutMs);
    try {
      const response = await this.fetcher(url, {
        method,
        headers: {
          ...(await this.auth.getHeaders()),
          Accept:
            options.responseType === 'text' ? 'text/plain' : 'application/json',
          ...(options.body === undefined
            ? {}
            : { 'Content-Type': options.contentType ?? 'application/json' }),
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        redirect: 'manual',
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw httpError(response.status, writes, recovery);
      }
      if (
        options.allowEmpty &&
        (response.status === 204 ||
          response.headers.get('content-length') === '0')
      ) {
        await response.body?.cancel();
        return { data: schema.parse(undefined) };
      }
      const contentType = response.headers.get('content-type') ?? '';
      const validContentType = (
        options.responseType === 'text'
          ? /^text\/plain(?:\s*;|$)/iu
          : /^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/iu
      ).test(contentType);
      if (!validContentType && !options.allowEmpty) {
        await response.body?.cancel();
        throw new SafeError(
          'INVALID_RESPONSE',
          'Azure DevOps returned an unexpected content type. Check the server/collection URL and authentication configuration.',
        );
      }
      const reader = response.body?.getReader();
      if (!reader && options.allowEmpty)
        return { data: schema.parse(undefined) };
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
          if (totalBytes > (options.maxBytes ?? MAX_RESPONSE_BYTES)) {
            await reader.cancel();
            throw new SafeError(
              'RESPONSE_TOO_LARGE',
              options.responseType === 'text'
                ? 'Azure DevOps text response exceeds the configured byte limit. Select a narrower range.'
                : 'Azure DevOps response exceeds 8 MiB. Use a smaller page or narrower filter.',
            );
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      if (!totalBytes && options.allowEmpty)
        return { data: schema.parse(undefined) };
      if (!validContentType)
        throw new SafeError(
          'INVALID_RESPONSE',
          'Azure DevOps returned an unexpected content type. Check the server/collection URL and authentication configuration.',
        );
      let data: T;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        data = schema.parse(
          options.responseType === 'text'
            ? text
            : options.allowEmpty && !text
              ? undefined
              : JSON.parse(text),
        );
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
          writes &&
          ['INVALID_RESPONSE', 'RESPONSE_TOO_LARGE'].includes(error.code)
        ) {
          throw new SafeError(
            error.code,
            `${error.message} A success response was received, but the write result could not be verified; ${recovery}.`,
            error.status,
          );
        }
        throw error;
      }
      const uncertain = !writes
        ? ''
        : ` The write outcome may be unknown; ${recovery}.`;
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

function httpError(
  status: number,
  writes: boolean,
  recovery: string,
): SafeError {
  const hints: Record<number, string> = {
    400: 'Azure DevOps rejected the request. Check the arguments and configured API version.',
    401: 'Authentication failed. Check the PAT and its expiry.',
    403: 'Access denied. Check PAT scopes and project/repository permissions.',
    404: 'Resource not found or not visible to this identity. Check collection, project, repository, and permissions.',
    409: 'The operation conflicts with existing state. Read the current resource and revision before trying again.',
    412: 'The resource changed since it was read. Read its current revision before trying again.',
    429: 'Azure DevOps is rate limiting requests. Wait before trying again.',
  };
  const message =
    status >= 300 && status < 400
      ? 'Azure DevOps redirected the request. Configure its final URL; redirects are not followed.'
      : (hints[status] ?? `Azure DevOps request failed (HTTP ${status}).`);
  const uncertain =
    writes && status >= 500
      ? ` The write outcome may be unknown; ${recovery}.`
      : '';
  return new SafeError(`HTTP_${status}`, message + uncertain, status);
}
