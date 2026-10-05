import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AdoClient } from '../../src/ado/client.js';
import { PatAuthProvider } from '../../src/ado/auth.js';
import { loadConfig } from '../../src/config.js';
import { endpointVersion } from '../../src/ado/api-version.js';

const config = loadConfig({
  ADO_SERVER_URL: 'https://devops.example.test/tfs',
  ADO_COLLECTION: 'Collection',
  ADO_TOKEN: 'secret-never-echoed',
});
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const rest = (fetcher: typeof fetch) =>
  new AdoClient(config, new PatAuthProvider(config.token), fetcher);
describe('shared Phase 2 transport', () => {
  it('selects endpoint versions centrally and never accepts a query override', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ ok: true }));
    await rest(fetcher).request(['_apis'], z.object({ ok: z.boolean() }), {
      endpoint: 'workItemComments',
      query: { 'api-version': '99' },
    });
    expect(
      new URL(String(fetcher.mock.calls[0]![0])).searchParams.get(
        'api-version',
      ),
    ).toBe('7.0-preview.3');
    expect(endpointVersion('7.1', 'identities')).toBe('7.1-preview.1');
    expect(endpointVersion('6.0', 'phase2')).toBeUndefined();
    expect(endpointVersion('7.0', 'phase2')).toBe('7.0');
  });
  it('rejects older versions before accessing new endpoints', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      new AdoClient(
        { ...config, apiVersion: '6.0' },
        new PatAuthProvider(config.token),
        fetcher,
      ).request(['_apis'], z.unknown(), { endpoint: 'phase2' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_API_VERSION' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses JSON Patch for revision updates and accepts empty DELETE responses', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ rev: 2 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await rest(fetcher).request(['_apis'], z.object({ rev: z.number() }), {
      method: 'PATCH',
      contentType: 'application/json-patch+json',
      body: [{ op: 'test', path: '/rev', value: 1 }],
    });
    expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({
      'Content-Type': 'application/json-patch+json',
    });
    expect(
      await rest(fetcher).request(['_apis'], z.unknown(), {
        method: 'DELETE',
        allowEmpty: true,
      }),
    ).toEqual({ data: undefined });
  });
  it.each(['transport', 'http', 'json'])(
    'does not label a read-only POST as a write after %s failure',
    async (kind) => {
      const fetcher = vi.fn<typeof fetch>();
      if (kind === 'transport')
        fetcher.mockRejectedValue(new Error(config.token));
      else
        fetcher.mockResolvedValue(
          json(
            kind === 'json' ? {} : { value: true },
            kind === 'http' ? 500 : 200,
          ),
        );
      try {
        await rest(fetcher).request(
          ['_apis'],
          z.object({ value: z.boolean() }),
          { method: 'POST', body: {}, readOnly: true },
        );
        throw new Error('unexpected success');
      } catch (error) {
        expect(String(error)).not.toMatch(
          /write|retrying|pull requests|secret-never-echoed/,
        );
      }
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('uses resource-specific write recovery without retrying', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({}, 500));
    await expect(
      rest(fetcher).request(['_apis'], z.unknown(), {
        method: 'PUT',
        recovery: 'inspect work items before retrying',
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('inspect work items before retrying'),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('reads plain text with bounded streaming, auth and denied redirects', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('line one\nline two', {
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'x-ms-continuationtoken': 'opaque',
          },
        }),
      );
    const response = await rest(fetcher).requestText(['_apis'], {
      maxBytes: 100,
    });
    expect(response).toEqual({
      data: 'line one\nline two',
      continuationToken: 'opaque',
    });
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      headers: {
        Accept: 'text/plain',
        Authorization: expect.stringContaining('Basic '),
      },
    });
  });
  it.each(['text/html', 'application/json', 'application/octet-stream'])(
    'rejects unexpected text content type %s',
    async (contentType) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(config.token, {
            headers: { 'content-type': contentType },
          }),
        );
      await expect(rest(fetcher).requestText(['_apis'])).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
      });
    },
  );
  it('enforces text byte limits and rejects unsafe requested limits before fetch', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('ééé', { headers: { 'content-type': 'text/plain' } }),
      );
    await expect(
      rest(fetcher).requestText(['_apis'], { maxBytes: 5 }),
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    for (const maxBytes of [0, 1.5, 1024 * 1024 + 1])
      await expect(
        rest(fetcher).requestText(['_apis'], { maxBytes }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not follow text redirects or expose upstream errors', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(config.token, {
          status: 302,
          headers: { location: 'https://outside.example.test' },
        }),
      );
    await expect(rest(fetcher).requestText(['_apis'])).rejects.toMatchObject({
      code: 'HTTP_302',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
