import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AdoClient } from '../../src/ado/client.js';
import { PatAuthProvider } from '../../src/ado/auth.js';
import { loadConfig } from '../../src/config.js';

const config = loadConfig({
  ADO_SERVER_URL: 'https://devops.example.test:8443/tfs',
  ADO_COLLECTION: 'Default Collection',
  ADO_TOKEN: 'never-show-this-token',
});
const schema = z.object({ value: z.array(z.string()) });
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

describe('REST client', () => {
  it('reports an unverified write result if a successful response is malformed', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ unexpected: true }));
    const client = new AdoClient(
      config,
      new PatAuthProvider(config.token),
      fetcher,
    );
    await expect(
      client.request(['_apis'], schema, { method: 'POST', body: {} }),
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: expect.stringContaining('inspect pull requests before retrying'),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('preserves virtual directories and encodes identifiers and query values', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ value: ['repo'], extra: 'stripped' }));
    const client = new AdoClient(
      config,
      new PatAuthProvider(config.token),
      fetcher,
    );
    const response = await client.request(
      ['Web Site', '_apis', 'git', 'repositories', 'repo/#?'],
      schema,
      { query: { filter: 'heads/feature/one&two', 'api-version': '9.0' } },
    );
    expect(response.data).toEqual({ value: ['repo'] });
    const [url, init] = fetcher.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe(
      '/tfs/Default%20Collection/Web%20Site/_apis/git/repositories/repo%2F%23%3F',
    );
    expect(parsed.searchParams.get('filter')).toBe('heads/feature/one&two');
    expect(parsed.searchParams.get('api-version')).toBe('7.0');
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(['.', '..', ''])(
    'rejects unsafe path segment %j before any HTTP request',
    async (segment) => {
      const fetcher = vi.fn<typeof fetch>();
      const client = new AdoClient(
        config,
        new PatAuthProvider(config.token),
        fetcher,
      );
      await expect(
        client.request([segment, '_apis'], schema),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([302, 400, 401, 403, 404, 409, 429, 500])(
    'returns safe HTTP %i errors and never retries',
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ message: config.token }, status));
      const client = new AdoClient(
        config,
        new PatAuthProvider(config.token),
        fetcher,
      );
      await expect(
        client.request(['_apis', 'projects'], schema),
      ).rejects.toMatchObject({ code: `HTTP_${status}`, status });
      try {
        await client.request(['_apis'], schema);
      } catch (error) {
        expect(String(error)).not.toContain(config.token);
      }
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it('does not expose thrown transport errors', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(config.token));
    const client = new AdoClient(
      config,
      new PatAuthProvider(config.token),
      fetcher,
    );
    await expect(
      client.request(['_apis'], schema, { method: 'POST', body: {} }),
    ).rejects.toMatchObject({
      code: 'CONNECTION_ERROR',
      message: expect.stringContaining('write outcome may be unknown'),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    () =>
      new Response('<html>login</html>', {
        headers: { 'content-type': 'text/html' },
      }),
    () =>
      new Response('{invalid}', {
        headers: { 'content-type': 'application/json' },
      }),
    () => jsonResponse({ value: [null] }),
  ])(
    'rejects login pages, malformed JSON and incompatible payloads',
    async (response) => {
      const client = new AdoClient(
        config,
        new PatAuthProvider(config.token),
        vi.fn<typeof fetch>().mockResolvedValue(response()),
      );
      await expect(client.request(['_apis'], schema)).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
      });
    },
  );

  it('limits response body size', async () => {
    const client = new AdoClient(
      config,
      new PatAuthProvider(config.token),
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          jsonResponse({ value: ['a'.repeat(8 * 1024 * 1024)] }),
        ),
    );
    await expect(client.request(['_apis'], schema)).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
    });
  });

  it('reads continuation and product-version headers without returning raw headers', async () => {
    const response = jsonResponse({ value: [] });
    response.headers.set('x-ms-continuationtoken', 'next+page');
    response.headers.set('x-tfs-product-version', '19.205.33122.1');
    response.headers.set('secret-header', config.token);
    const client = new AdoClient(
      config,
      new PatAuthProvider(config.token),
      vi.fn<typeof fetch>().mockResolvedValue(response),
    );
    expect(await client.request(['_apis'], schema)).toEqual({
      data: { value: [] },
      continuationToken: 'next+page',
      productVersion: '19.205.33122.1',
    });
  });
});
