import type { Config } from '../config.js';
import type { AdoClient } from '../ado/client.js';
import { projectSchema, type Project } from '../ado/types.js';
import { SafeError } from '../errors.js';
import { matchesIdentifier } from './repositories.js';

/** Independent of repository permissions. Missing configuration is deny-all. */
export class WorkItemScope {
  private readonly reads;
  private readonly writes;
  constructor(
    private readonly client: AdoClient,
    private readonly config: Pick<
      Config,
      'project' | 'allowedWorkItemProjects' | 'workItemWriteProjects'
    >,
  ) {
    this.reads = [...(config.allowedWorkItemProjects ?? [])];
    this.writes = [...(config.workItemWriteProjects ?? [])];
  }
  async resolve(project: string | undefined, write = false): Promise<Project> {
    const selected = project?.trim() || this.config.project;
    if (!selected)
      throw new SafeError(
        'PROJECT_REQUIRED',
        'Provide project or configure ADO_PROJECT.',
      );
    if (!this.reads.length || (write && !this.writes.length))
      throw denied(write);
    // Only look up configured projects, never an arbitrary caller-supplied project.
    for (const selector of this.reads) {
      const result = (
        await this.client.request(
          ['_apis', 'projects', selector],
          projectSchema,
          { endpoint: 'phase2' },
        )
      ).data;
      if (!matchesIdentifier(selector, result)) throw denied(false);
      if (matchesIdentifier(selected, result)) {
        if (
          write &&
          !this.writes.some((entry) => matchesIdentifier(entry, result))
        )
          throw denied(true);
        return result;
      }
    }
    throw denied(write);
  }
  verify(project: Project, actual: unknown): void {
    if (
      typeof actual !== 'string' ||
      actual.toLowerCase() !== project.name.toLowerCase()
    )
      throw denied(false);
  }
}
function denied(write: boolean): SafeError {
  return new SafeError(
    'WORK_ITEM_PROJECT_NOT_ALLOWED',
    write
      ? 'Work-item writes require this project in both ADO_ALLOWED_WORK_ITEM_PROJECTS and ADO_WORK_ITEM_WRITE_PROJECTS in the MCP process configuration.'
      : 'This work-item project is outside ADO_ALLOWED_WORK_ITEM_PROJECTS. Omitted or [] denies all work-item reads.',
  );
}
