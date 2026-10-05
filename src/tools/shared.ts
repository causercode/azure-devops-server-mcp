import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { SafeError } from '../errors.js';

export const projectInput = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .optional()
  .describe(
    'Project name or ID. Defaults to ADO_PROJECT; discover with server_info/list_projects.',
  );
export const repositoryInput = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .describe('Repository name or ID in the selected project.');
export const topInput = z
  .number()
  .int()
  .min(1)
  .max(100)
  .default(25)
  .describe('Maximum results per page (1–100).');
export const skipInput = z
  .number()
  .int()
  .min(0)
  .max(1000000)
  .default(0)
  .describe('Page offset. Pass nextSkip from the previous response.');
export const continuationInput = z
  .string()
  .min(1)
  .max(4096)
  .optional()
  .describe(
    'Opaque continuationToken from the previous response. Keep the same filters.',
  );
export const branchInput = z
  .string()
  .min(1)
  .max(1024)
  .describe(
    'Short branch name, such as feature/foo, or refs/heads/feature/foo.',
  );
export const pullRequestIdInput = z
  .number()
  .int()
  .positive()
  .max(2147483647)
  .describe('Numeric Azure DevOps pull request ID.');
export const guidInput = z
  .string()
  .regex(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu)
  .describe('Explicit Azure DevOps identity/resource GUID.');

export const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
export const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export type ToolRunner = (
  operation: () => Promise<unknown>,
) => Promise<CallToolResult>;

export function createToolRunner(
  redact: (text: string) => string,
  scope: <T>(operation: () => Promise<T>) => Promise<T> = (operation) =>
    operation(),
): ToolRunner {
  return (operation) =>
    scope(async () => {
      try {
        const serialized = redact(JSON.stringify(await operation()));
        return {
          content: [{ type: 'text', text: serialized }],
          structuredContent: JSON.parse(serialized),
        };
      } catch (error) {
        const safe =
          error instanceof SafeError
            ? {
                code: error.code,
                message: error.message,
                ...(error.status === undefined ? {} : { status: error.status }),
              }
            : {
                code: 'INTERNAL_ERROR',
                message:
                  'An unexpected internal error occurred. No diagnostic details are exposed to protect credentials.',
              };
        const serialized = redact(JSON.stringify({ error: safe }));
        return {
          isError: true,
          content: [{ type: 'text', text: serialized }],
          structuredContent: JSON.parse(serialized),
        };
      }
    });
}

export function required<T>(
  value: T | undefined,
  field: string,
  action: string,
): T {
  if (value === undefined)
    throw new SafeError(
      'INVALID_ARGUMENT',
      `${field} is required for action ${action}.`,
    );
  return value;
}

export function rejectFields(
  input: Record<string, unknown>,
  fields: readonly string[],
): void {
  if (fields.some((field) => input[field] !== undefined)) {
    throw new SafeError(
      'INVALID_ARGUMENT',
      `This action does not accept: ${fields.join(', ')}.`,
    );
  }
}

/** Optional schema fields are accepted only by their documented action. */
export function allowFields(
  input: Record<string, unknown>,
  fields: readonly string[],
): void {
  const allowed = new Set(['action', 'project', ...fields]);
  rejectFields(
    input,
    Object.keys(input).filter((key) => !allowed.has(key)),
  );
}
