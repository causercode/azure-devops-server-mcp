import { describe, expect, it } from 'vitest';
import { scopedWiql } from '../../src/services/queries.js';
import { loadConfig } from '../../src/config.js';

describe('work item authorization and WIQL validation', () => {
  const env = {
    ADO_SERVER_URL: 'https://example.test/tfs',
    ADO_COLLECTION: 'Collection',
    ADO_TOKEN: 'secret',
  };
  it('defaults work-item scopes to deny-all without changing legacy config shape', () => {
    expect(loadConfig(env).allowedWorkItemProjects).toBeUndefined();
    expect(loadConfig(env).workItemWriteProjects).toBeUndefined();
    expect(
      loadConfig({
        ...env,
        ADO_ALLOWED_WORK_ITEM_PROJECTS: '["Example"]',
        ADO_WORK_ITEM_WRITE_PROJECTS: '[]',
      }),
    ).toMatchObject({
      allowedWorkItemProjects: ['Example'],
      workItemWriteProjects: [],
    });
  });
  it.each([
    '*',
    '["*"]',
    '["../Other"]',
    '["a/b"]',
    '{}',
    '[{"project":"a"}]',
    'null',
  ])('rejects unsafe project scope %s', (value) => {
    for (const key of [
      'ADO_ALLOWED_WORK_ITEM_PROJECTS',
      'ADO_WORK_ITEM_WRITE_PROJECTS',
    ])
      expect(() => loadConfig({ ...env, [key]: value })).toThrow(/JSON array/);
  });
  it('wraps OR expressions, quotes project names, and handles escaped strings/macros/ORDER BY', () => {
    const wiql =
      "SELECT [System.Id] FROM WorkItems WHERE ([System.Title] = 'it''s (safe)' OR [System.AssignedTo] = @Me) ORDER BY [System.Id] DESC, [System.Title]";
    expect(scopedWiql(wiql, "Team's Project")).toContain(
      "AND [System.TeamProject] = 'Team''s Project' ORDER BY",
    );
  });
  it('normalizes saved-query field projections into bounded ID discovery', () => {
    expect(
      scopedWiql(
        'SELECT [System.Id], [System.Title], [Custom.Field] FROM WorkItems WHERE [System.Id] > 0',
        'Approved',
      ),
    ).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE ([System.Id] > 0) AND [System.TeamProject] = 'Approved'",
    );
  });
  it.each([
    "SELECT [System.Id] FROM WorkItems WHERE ([System.Id] > 0)) OR ([System.TeamProject] = 'Other'",
    'SELECT [System.Id] FROM WorkItems WHERE [System.Id] > 0; SELECT [System.Id] FROM WorkItems',
    'SELECT [System.Id] FROM WorkItemLinks WHERE [Source].[System.TeamProject] = @Project',
    "SELECT [System.Id] FROM WorkItems WHERE [System.Id] > 0 ASOF '2020-01-01'",
    "SELECT [System.Id] FROM WorkItems WHERE [System.Title] = 'unterminated",
    'SELECT [System.Id] FROM WorkItems WHERE [System.Id] > 0 -- escape',
    'SELECT [System.Id] FROM WorkItems WHERE [System.Id] > 0 /* escape */',
    'SELECT [System.Id] FROM WorkItems WHERE [System.Id] > 0 ORDER BY 1',
    'SELECT * FROM WorkItems WHERE [System.Id] > 0',
    'SELECT [System.Id] FROM WorkItems WHERE [System.Id] > 0 MODE (Recursive)',
  ])('rejects unsafe/unsupported query %s', (query) => {
    expect(() => scopedWiql(query, 'Approved')).toThrow();
  });
});
