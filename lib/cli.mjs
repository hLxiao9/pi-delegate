import { WorkerError, serializeError } from './errors.mjs';

export const COMMANDS = ['doctor', 'prepare', 'run', 'revise', 'verify', 'approve', 'integrate', 'report', 'cleanup'];

export function helpText() {
  return `pi-worker - Codex-owned Pi implementation worker

Usage:
  pi-worker doctor [--task <task.json>]
  pi-worker prepare --task <task.json> [--codex-start <usage-start.json>]
  pi-worker run --id <run-id>
  pi-worker revise --id <run-id> --review <review.json>
  pi-worker verify --id <run-id>
  pi-worker approve --id <run-id> --review <review.json> --message <commit-message>
  pi-worker integrate --id <run-id>
  pi-worker report --id <run-id> [--chatgpt-image-generations <count>]
  pi-worker cleanup --id <run-id>
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
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new WorkerError('CLI_USAGE', `${flag} requires a value`, {}, 2);
    if (Object.hasOwn(options, key)) throw new WorkerError('CLI_USAGE', `Duplicate option: ${flag}`, {}, 2);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

export async function main(argv, io = process, handlers = {}) {
  try {
    const parsed = parseCli(argv);
    if (parsed.help) {
      io.stdout.write(helpText());
      return 0;
    }
    const handler = handlers[parsed.command];
    if (!handler) throw new WorkerError('NOT_IMPLEMENTED', `${parsed.command} is not implemented`, {}, 1);
    const result = await handler(parsed.options);
    io.stdout.write(`${JSON.stringify({ ok: true, command: parsed.command, ...result })}\n`);
    return 0;
  } catch (error) {
    const serialized = serializeError(error);
    io.stderr.write(`${JSON.stringify(serialized)}\n`);
    return error instanceof WorkerError ? error.exitCode : 1;
  }
}
