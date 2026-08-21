#!/usr/bin/env node
import { Command } from 'commander';
import { runDoctor } from './doctor.js';
import { initProject } from './init.js';
import { showStatus } from './status.js';

const program = new Command();

program
  .name('shipgraph')
  .description('Deterministic release control for autonomous coding agents.')
  .version('0.1.0');

program
  .command('doctor')
  .description('Check the ShipGraph environment')
  .option('--json', 'output structured diagnostics as JSON')
  .action(async (options: { json?: boolean }) => {
    await runDoctor({ json: options.json });
  });

program
  .command('init')
  .description('Initialize ShipGraph metadata for the current project')
  .option('--project-dir <path>', 'target project directory', process.cwd())
  .action(async (options: { projectDir?: string }) => {
    const projectDir = options.projectDir ?? process.cwd();
    const result = initProject(projectDir);
    console.log('ShipGraph initialized:');
    console.log(`  projectId: ${result.projectId}`);
    console.log(`  state dir: ${result.createdStateDir ? 'created' : 'already exists'}`);
    console.log(`  global dir: ${result.createdGlobalDir ? 'created' : 'already exists'}`);
    console.log(`  example config: ${result.wroteExampleConfig ? 'written' : 'skipped'}`);
  });

program
  .command('status')
  .description('Show project metadata and ticket counts')
  .option('--project-dir <path>', 'target project directory', process.cwd())
  .option('--json', 'output structured status as JSON')
  .action(async (options: { projectDir?: string; json?: boolean }) => {
    const projectDir = options.projectDir ?? process.cwd();
    showStatus(projectDir, { json: options.json });
  });

program.parse();
