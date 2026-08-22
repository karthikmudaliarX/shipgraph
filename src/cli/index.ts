#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runDoctor } from './doctor.js';
import { initProject } from './init.js';
import { showStatus } from './status.js';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('shipgraph')
    .description('Deterministic release control for autonomous coding agents.')
    .version(readPackageVersion());

  program
    .command('doctor')
    .description('Check the ShipGraph environment')
    .option('--json', 'output structured diagnostics as JSON')
    .action(async (options: { json?: boolean }) => {
      const report = await runDoctor({ json: options.json });
      if (!report.healthy) process.exitCode = 1;
    });

  program
    .command('init')
    .description('Initialize ShipGraph metadata for the current project')
    .option('--project-dir <path>', 'target project directory', process.cwd())
    .action((options: { projectDir?: string }) => {
      const projectDir = options.projectDir ?? process.cwd();
      const result = initProject(projectDir);
      if (result.configurationRequired) {
        console.log(
          result.wroteConfigTemplate
            ? 'ShipGraph configuration template written to shipgraph.yml.'
            : 'ShipGraph is waiting for project identity in shipgraph.yml.'
        );
        console.log('Fill in project.name and project.repository, then run `shipgraph init` again.');
        return;
      }
      console.log('ShipGraph initialized:');
      console.log(`  projectId: ${result.projectId}`);
      console.log(`  state dir: ${result.createdStateDir ? 'created' : 'already exists'}`);
      console.log(`  global dir: ${result.createdGlobalDir ? 'created' : 'already exists'}`);
    });

  program
    .command('status')
    .description('Show project metadata and ticket counts')
    .option('--project-dir <path>', 'target project directory', process.cwd())
    .option('--json', 'output structured status as JSON')
    .action((options: { projectDir?: string; json?: boolean }) => {
      const projectDir = options.projectDir ?? process.cwd();
      const report = showStatus(projectDir, { json: options.json });
      if (report.error) process.exitCode = 1;
    });

  return program;
}

function readPackageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
  ) as { version: string };
  return packageJson.version;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  await createProgram().parseAsync();
}
