import { createProcessRunner, type ProcessRunner } from '../utils/process-runner.js';
import { createInMemoryDatabase } from '../persistence/db.js';

export type DoctorCheckName =
  | 'node_version'
  | 'git_available'
  | 'gh_available'
  | 'gh_authenticated'
  | 'pnpm_available'
  | 'sqlite_operational'
  | 'opencode_installed'
  | 'codex_installed';

export type DoctorCheck = {
  name: DoctorCheckName;
  status: 'pass' | 'fail' | 'info';
  message: string;
  detail?: Record<string, unknown>;
};

export type DoctorReport = {
  healthy: boolean;
  checks: DoctorCheck[];
};

const MINIMUM_NODE_MAJOR = 22;

export async function runDoctor(options: {
  runner?: ProcessRunner;
  json?: boolean;
} = {}): Promise<DoctorReport> {
  const runner = options.runner ?? createProcessRunner();
  const checks: DoctorCheck[] = [];

  // Node version
  checks.push(checkNodeVersion(process.version));

  // git available
  const gitResult = await runner.run('git', ['--version']);
  checks.push({
    name: 'git_available',
    status: gitResult.exitCode === 0 ? 'pass' : 'fail',
    message:
      gitResult.exitCode === 0
        ? `git available: ${gitResult.stdout.trim()}`
        : 'git not found in PATH',
  });

  // gh available and authenticated
  const ghResult = await runner.run('gh', ['--version']);
  if (ghResult.exitCode !== 0) {
    checks.push({
      name: 'gh_available',
      status: 'fail',
      message: 'gh (GitHub CLI) not found in PATH',
    });
    checks.push({
      name: 'gh_authenticated',
      status: 'fail',
      message: 'gh not available; cannot check authentication',
    });
  } else {
    checks.push({
      name: 'gh_available',
      status: 'pass',
      message: `gh available: ${ghResult.stdout.split('\n')[0]?.trim() ?? ''}`,
    });
    const authResult = await runner.run('gh', ['auth', 'status']);
    checks.push({
      name: 'gh_authenticated',
      status: authResult.exitCode === 0 ? 'pass' : 'fail',
      message:
        authResult.exitCode === 0
          ? 'gh is authenticated'
          : 'gh is not authenticated',
    });
  }

  // pnpm available
  const pnpmResult = await runner.run('pnpm', ['--version']);
  checks.push({
    name: 'pnpm_available',
    status: pnpmResult.exitCode === 0 ? 'pass' : 'fail',
    message:
      pnpmResult.exitCode === 0
        ? `pnpm available: ${pnpmResult.stdout.trim()}`
        : 'pnpm not found in PATH',
  });

  // SQLite operational
  checks.push(checkSqliteOperational());

  // OpenCode installed (informational in CORE-001)
  const opencodeResult = await runner.run('opencode', ['--version']);
  checks.push({
    name: 'opencode_installed',
    status: opencodeResult.exitCode === 0 ? 'pass' : 'info',
    message:
      opencodeResult.exitCode === 0
        ? `OpenCode available: ${opencodeResult.stdout.trim()}`
        : 'OpenCode not installed (informational for CORE-001)',
  });

  // Codex installed (informational in CORE-001)
  const codexResult = await runner.run('codex', ['--version']);
  checks.push({
    name: 'codex_installed',
    status: codexResult.exitCode === 0 ? 'pass' : 'info',
    message:
      codexResult.exitCode === 0
        ? `Codex available: ${codexResult.stdout.trim()}`
        : 'Codex not installed (informational for CORE-001)',
  });

  const healthy = checks.every(
    (check) => check.status === 'pass' || check.status === 'info'
  );

  const report: DoctorReport = { healthy, checks };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printDoctorReport(report);
  }

  return report;
}

function checkNodeVersion(versionString: string): DoctorCheck {
  const match = versionString.match(/v?(\d+)\.\d+\.\d+/);
  const major = match ? Number(match[1]) : 0;
  return {
    name: 'node_version',
    status: major >= MINIMUM_NODE_MAJOR ? 'pass' : 'fail',
    message: `Node.js ${versionString} (required >= ${MINIMUM_NODE_MAJOR})`,
    detail: { major, required: MINIMUM_NODE_MAJOR },
  };
}

function checkSqliteOperational(): DoctorCheck {
  try {
    const db = createInMemoryDatabase();
    const result = db.prepare('SELECT 1 as value').get() as { value: number };
    db.close();
    return {
      name: 'sqlite_operational',
      status: result.value === 1 ? 'pass' : 'fail',
      message: 'SQLite operational',
    };
  } catch (error) {
    return {
      name: 'sqlite_operational',
      status: 'fail',
      message: `SQLite not operational: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function printDoctorReport(report: DoctorReport): void {
  console.log(`ShipGraph doctor: ${report.healthy ? 'healthy' : 'unhealthy'}`);
  for (const check of report.checks) {
    const icon = check.status === 'pass' ? '✓' : check.status === 'info' ? 'ℹ' : '✗';
    console.log(`  ${icon} [${check.status.toUpperCase()}] ${check.name}: ${check.message}`);
  }
}
