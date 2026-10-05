import type { AdoClient } from '../ado/client.js';
import { listSchema } from '../ado/types.js';
import { savedQuerySchema, queryResultSchema } from '../ado/phase2-types.js';
import type { WorkItemService } from './work-items.js';
import { witPath } from './work-items.js';
import { SafeError } from '../errors.js';
import { page } from './bounds.js';

/** Accept a deliberately limited flat WIQL grammar. The project guard wraps the entire expression. */
export function scopedWiql(query: string, projectName: string): string {
  const invalid = () =>
    new SafeError(
      'INVALID_ARGUMENT',
      'Only flat SELECT [fields] FROM WorkItems WHERE queries are supported; projection is normalized to System.Id. No comments, ASOF, link queries, or additional statements.',
    );
  const match =
    /^\s*SELECT\s+(?:\[[A-Za-z][A-Za-z0-9_.]*\]\s*,\s*)*\[[A-Za-z][A-Za-z0-9_.]*\]\s+FROM\s+WorkItems\s+WHERE\s+([\s\S]+?)\s*$/iu.exec(
      query,
    );
  if (
    !match ||
    /[;\u0000-\u0008\u000b\u000c\u000e-\u001f]|--|\/\*|\*\//u.test(query)
  )
    throw invalid();
  let expression = match[1]!;
  // Strip strings/field references before recognizing keywords and parentheses.
  let syntax = '';
  for (let i = 0; i < expression.length; i++) {
    const c = expression[i]!;
    if (c === "'" || c === '"') {
      const quote = c;
      let closed = false;
      while (++i < expression.length) {
        if (expression[i] === quote) {
          if (expression[i + 1] === quote) {
            i++;
            continue;
          }
          closed = true;
          break;
        }
      }
      if (!closed) throw invalid();
      syntax += ' ';
    } else if (c === '[') {
      const end = expression.indexOf(']', i + 1);
      if (
        end < 0 ||
        !/^[A-Za-z][A-Za-z0-9_.]*$/u.test(expression.slice(i + 1, end))
      )
        throw invalid();
      syntax += ' ';
      i = end;
    } else syntax += c;
  }
  if (/\b(SELECT|FROM|ASOF|MODE|UNION|WHERE)\b/iu.test(syntax)) throw invalid();
  const order = /\bORDER\s+BY\b/iu.exec(syntax);
  let orderBy = '';
  if (order) {
    // Syntax retains fewer characters than the original, so locate ORDER BY only outside quoted strings with a second scan.
    const suffix =
      /\s+ORDER\s+BY\s+((?:\[[A-Za-z][A-Za-z0-9_.]*\](?:\s+(?:ASC|DESC))?)(?:\s*,\s*\[[A-Za-z][A-Za-z0-9_.]*\](?:\s+(?:ASC|DESC))?)*)\s*$/iu.exec(
        expression,
      );
    if (!suffix) throw invalid();
    orderBy = ` ORDER BY ${suffix[1]}`;
    expression = expression.slice(0, suffix.index);
    syntax = syntax.slice(0, order.index);
  }
  let depth = 0;
  for (const c of syntax) {
    if (c === '(') depth++;
    if (c === ')' && --depth < 0) throw invalid();
  }
  if (depth !== 0 || !expression.trim()) throw invalid();
  return `SELECT [System.Id] FROM WorkItems WHERE (${expression}) AND [System.TeamProject] = '${projectName.replaceAll("'", "''")}'${orderBy}`;
}

export class QueryService {
  constructor(
    private readonly client: AdoClient,
    private readonly workItems: WorkItemService,
  ) {}
  async read(
    project: string | undefined,
    action: 'list' | 'get',
    queryId: string | undefined,
    top: number,
    skip: number,
  ) {
    const resolved = await this.workItems.scope.resolve(project);
    const path = [
      ...witPath(resolved),
      'queries',
      ...(queryId ? [queryId] : []),
    ];
    if (action === 'get' || queryId) {
      const result = (
        await this.client.request(path, savedQuerySchema, {
          endpoint: 'phase2',
          query: { $depth: 1, $expand: 'minimal' },
        })
      ).data;
      if (queryId && result.id.toLowerCase() !== queryId.toLowerCase())
        throw new SafeError(
          'INVALID_RESPONSE',
          'The server returned a different saved query ID.',
        );
      if (action === 'get') return this.summary(result);
      return page(
        (result.children ?? []).map((item) => this.summary(item)),
        top,
        skip,
      );
    }
    return page(
      (
        await this.client.request(path, listSchema(savedQuerySchema), {
          endpoint: 'phase2',
          query: { $depth: 1 },
        })
      ).data.value.map((item) => this.summary(item)),
      top,
      skip,
    );
  }
  private summary(query: {
    id: string;
    name: string;
    isFolder?: boolean | undefined;
    queryType?: string | undefined;
  }) {
    return {
      id: query.id,
      name: query.name.slice(0, 256),
      isFolder: query.isFolder ?? false,
      queryType: query.queryType ?? null,
    };
  }
  async execute(
    project: string | undefined,
    top: number,
    input: { wiql?: string; queryId?: string },
  ) {
    const resolved = await this.workItems.scope.resolve(project);
    let query = input.wiql;
    if (input.queryId) {
      const result = (
        await this.client.request(
          [...witPath(resolved), 'queries', input.queryId],
          savedQuerySchema,
          { endpoint: 'phase2', query: { $expand: 'wiql' } },
        )
      ).data;
      if (result.id.toLowerCase() !== input.queryId.toLowerCase())
        throw new SafeError(
          'INVALID_RESPONSE',
          'The server returned a different saved query ID.',
        );
      if (result.isFolder || result.queryType !== 'flat' || !result.wiql)
        throw new SafeError(
          'INVALID_ARGUMENT',
          'Select a flat saved query with WIQL; folders and link queries cannot be executed.',
        );
      query = result.wiql;
    }
    const scoped = scopedWiql(query!, resolved.name);
    const result = (
      await this.client.request(
        [...witPath(resolved), 'wiql'],
        queryResultSchema,
        {
          endpoint: 'phase2',
          method: 'POST',
          readOnly: true,
          query: { $top: top },
          body: { query: scoped },
        },
      )
    ).data;
    if (
      result.queryType !== 'flat' ||
      !result.workItems ||
      result.workItems.length > top
    )
      throw new SafeError(
        'INVALID_RESPONSE',
        'The server did not return the requested bounded flat query results.',
      );
    const ids = result.workItems.map((item) => item.id);
    if (ids.length)
      await this.workItems.batchVerified(resolved, ids, ['System.TeamProject']);
    return {
      items: ids.map((id) => ({ id })),
      asOf: result.asOf ?? null,
      possiblyMore: ids.length === top,
      pagingNote:
        'Use a narrower WHERE or an ID boundary in WIQL for additional results; no offset continuation is provided.',
    };
  }
}
