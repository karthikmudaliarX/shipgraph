import { existsSync } from 'node:fs';
import { assertSafeShipgraphPaths } from '../utils/paths.js';
import { loadConfig } from '../config/loader.js';
import {
  assertMigrationsCompatible,
  openReadonlyDatabase,
  type DbConnection,
} from '../persistence/db.js';
import {
  createProjectRepository,
  createTicketRepository,
} from '../persistence/repositories.js';
import { persistedProjectMatchesConfig } from '../config/schema.js';
import { calculateReady, type ReadyReport } from '../scheduler/ready.js';

export function showReady(projectDir: string): ReadyReport {
  const paths = assertSafeShipgraphPaths(projectDir);
  const config = loadConfig(projectDir);
  if (!existsSync(paths.dbPath)) {
    throw new Error('No initialized ShipGraph project found. Run `shipgraph init` first.');
  }

  let db: DbConnection | undefined;
  try {
    db = openReadonlyDatabase(paths.dbPath);
    assertMigrationsCompatible(db);
    const projects = createProjectRepository(db).findAll();
    if (projects.length !== 1) {
      throw new Error(
        projects.length === 0
          ? 'No initialized ShipGraph project found. Run `shipgraph init` first.'
          : 'ShipGraph project database must contain exactly one project'
      );
    }
    const project = projects[0];
    if (!persistedProjectMatchesConfig(project, config)) {
      throw new Error(
        'shipgraph.yml does not match the project identity/config stored in .shipgraph/shipgraph.db'
      );
    }
    const tickets = createTicketRepository(db).findApprovedByProjectId(project.id);
    return calculateReady(tickets, config.execution.maxConcurrentTickets);
  } finally {
    db?.close();
  }
}
export function emitReady(report: ReadyReport, json = false): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('ShipGraph ready queue');
  console.log('');
  console.log(
    `Capacity: ${report.capacity.active} / ${report.capacity.maxConcurrentTickets} active`
  );
  console.log(`Available slots: ${report.capacity.available}`);
  console.log('');
  console.log('Dispatchable:');
  if (report.dispatchable.length === 0) console.log('  (none)');
  for (const ticket of report.dispatchable) {
    console.log(`  ${ticket.ticket}  ${ticket.priority}  ${sanitizeTerminalText(ticket.title)}`);
  }
  console.log('');
  console.log('Eligible:');
  if (report.eligible.length === 0) console.log('  (none)');
  for (const ticket of report.eligible) {
    console.log(`  ${ticket.ticket}  ${ticket.priority}  ${sanitizeTerminalText(ticket.title)}`);
  }
  console.log('');
  console.log('Waiting:');
  if (report.waiting.length === 0) console.log('  (none)');
  for (const waiting of report.waiting) {
    console.log(`  ${waiting.ticket}`);
    for (const blocker of waiting.blockers) {
      console.log(`    blocked by ${blocker.dependency} (${blocker.state})`);
      console.log(`    reason: ${blocker.reason}`);
    }
  }
}

function sanitizeTerminalText(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return !(
        codePoint < 0x20 ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        codePoint === 0x2028 ||
        codePoint === 0x2029
      );
    })
    .join('');
}
