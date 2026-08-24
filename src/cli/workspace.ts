import {
  createWorkspace,
  inspectWorkspace,
  listWorkspacesForProject,
  removeWorkspace,
  type WorkspaceServiceOptions,
} from '../workspace/service.js';

export function workspaceServiceOptions(
  db: WorkspaceServiceOptions['db'],
  projectDir: string,
  worktreeRoot?: string
): WorkspaceServiceOptions {
  return { db, projectDir, ...(worktreeRoot !== undefined ? { worktreeRoot } : {}) };
}

export async function runWorkspaceCreate(
  options: WorkspaceServiceOptions,
  ticketId: string
): Promise<Record<string, unknown>> {
  const result = await createWorkspace(options, ticketId);
  return {
    created: result.created,
    recovered: result.recovered,
    workspace: {
      id: result.workspace.id,
      projectId: result.workspace.projectId,
      ticketId: result.workspace.ticketId,
      branchName: result.workspace.branchName,
      baseSha: result.workspace.baseSha,
      worktreePath: result.workspace.worktreePath,
      status: result.workspace.status,
    },
    ticket: { ticketId: result.workspace.ticketId, state: result.ticketState },
  };
}

export async function runWorkspaceInspect(
  options: WorkspaceServiceOptions,
  ticketId: string
): Promise<Record<string, unknown>> {
  const report = await inspectWorkspace(options, ticketId);
  return {
    recorded: report.recorded,
    live: report.live,
    health: report.health,
  };
}

export function runWorkspaceList(options: WorkspaceServiceOptions): Record<string, unknown> {
  const workspaces = listWorkspacesForProject(options);
  return {
    workspaces: workspaces.map((workspace) => ({
      id: workspace.id,
      ticketId: workspace.ticketId,
      branchName: workspace.branchName,
      baseSha: workspace.baseSha,
      worktreePath: workspace.worktreePath,
      status: workspace.status,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    })),
  };
}

export async function runWorkspaceRemove(
  options: WorkspaceServiceOptions,
  ticketId: string
): Promise<Record<string, unknown>> {
  const result = await removeWorkspace(options, ticketId);
  return { ...result };
}
