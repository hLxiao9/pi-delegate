import { WorkerError, serializeError } from './errors.mjs';
import { withAuditLog } from './audit-log.mjs';
import { resolveWorkerPaths } from './config.mjs';

export const COMMANDS = ['doctor', 'prepare', 'run', 'revise', 'verify', 'self-review', 'recover', 'approve', 'integrate', 'report', 'cleanup', 'list', 'inspect', 'dashboard', 'serve'];

export function helpText() {
  return `pi-worker - Parent-agent-owned Pi implementation worker

Usage:
  pi-worker doctor [--task <task.json>]
  pi-worker prepare --task <task.json> [--usage-start <usage-start.json>]
  pi-worker run --id <run-id>
  pi-worker revise --id <run-id> --review <review.json>
  pi-worker verify --id <run-id>
  pi-worker self-review --id <run-id>
  pi-worker recover --id <run-id>
  pi-worker approve --id <run-id> --review <review.json> --message <commit-message>
  pi-worker integrate --id <run-id>
  pi-worker report --id <run-id> [--chatgpt-image-generations <count>]
  pi-worker cleanup --id <run-id>
  pi-worker list [--status <status>] [--caller <caller>] [--running]
  pi-worker inspect --id <run-id>
  pi-worker dashboard [--output <file>]
  pi-worker serve [--port <port>] [--no-open]
`;
}

export function parseCli(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') return { help: true };
  const command = argv[0];
  if (!COMMANDS.includes(command)) {
    throw new WorkerError('CLI_USAGE', `Unknown command: ${command}`, { command }, 2);
  }
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--')) throw new WorkerError('CLI_USAGE', `Unexpected argument: ${flag}`, {}, 2);
    const key = flag.slice(2);
    if (key.startsWith('no-') && (index + 1 >= argv.length || argv[index + 1].startsWith('--'))) {
      const realKey = key.slice(3);
      if (Object.hasOwn(options, realKey)) throw new WorkerError('CLI_USAGE', `Duplicate option: ${flag}`, {}, 2);
      options[realKey] = 'false';
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new WorkerError('CLI_USAGE', `${flag} requires a value`, {}, 2);
    if (Object.hasOwn(options, key)) throw new WorkerError('CLI_USAGE', `Duplicate option: ${flag}`, {}, 2);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

export async function main(argv, io = process, handlers = {}) {
  const paths = resolveWorkerPaths();
  try {
    const parsed = parseCli(argv);
    if (parsed.help) {
      io.stdout.write(helpText());
      return 0;
    }
    const handler = handlers[parsed.command];
    if (!handler) throw new WorkerError('NOT_IMPLEMENTED', `${parsed.command} is not implemented`, {}, 1);
    // 全局审计日志:记录每次命令调用的 caller/command/runId/args/result/duration。
    // 用于调试 skill bug(如修订回合误标 failed)和优化 skill 本身。
    const caller = process.env.PARENT_AGENT ?? process.env.PI_WORKER_CALLER ?? 'cli';
    const runId = parsed.options.id ?? null;
    const result = await withAuditLog(paths, { command: parsed.command, runId, caller, args: parsed.options }, () => handler(parsed.options));
    io.stdout.write(`${JSON.stringify({ ok: true, command: parsed.command, ...result })}\n`);
    return 0;
  } catch (error) {
    const serialized = serializeError(error);
    io.stderr.write(`${JSON.stringify(serialized)}\n`);
    return error instanceof WorkerError ? error.exitCode : 1;
  }
}
