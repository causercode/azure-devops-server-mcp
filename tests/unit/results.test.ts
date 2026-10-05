import { describe, expect, it } from 'vitest';
import { createToolRunner } from '../../src/tools/shared.js';
import { listSchema, repositorySchema } from '../../src/ado/types.js';
import { repository } from '../fixtures/ado-server.js';

describe('safe results and response normalization', () => {
  it('withholds arbitrary exception messages from tool results', async () => {
    const run = createToolRunner((text) => text);
    const result = await run(async () => {
      throw new Error('private environment contents');
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(
      'private environment contents',
    );
    expect(result.structuredContent).toMatchObject({
      error: { code: 'INTERNAL_ERROR' },
    });
  });

  it('allows empty repository metadata while stripping unrelated response fields', () => {
    expect(
      listSchema(repositorySchema).parse({
        value: [
          {
            ...repository,
            defaultBranch: null,
            webUrl: null,
            remoteUrl: null,
            secret: 'omitted',
          },
        ],
      }),
    ).toEqual({
      value: [
        { ...repository, defaultBranch: null, webUrl: null, remoteUrl: null },
      ],
    });
  });
});
