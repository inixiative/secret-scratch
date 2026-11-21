#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAcpProxy } from './acpProxy';
import { serveSecretScratchMcp } from './mcp';
import { SecretScratchPad } from './pad';
import { PACKAGE_VERSION } from './version';

const DEFAULT_DIR = join(homedir(), '.secret-scratch');

const HELP = `secret-scratch v${PACKAGE_VERSION}
Pass secrets to coding agents as $$value without the LLM or transcript seeing them.

Usage:
  secret-scratch [options] -- <acp-agent-command> [args...]
  secret-scratch mcp --dir <path> --thread <id> [--cwd <path>]
  secret-scratch list [--dir <path>] [--thread <id>]
  secret-scratch clear <thread> [--dir <path>]

Options:
  --dir <path>          Scratch pad directory (default: ~/.secret-scratch)
  --private <glob>      Extra private path glob to block (repeatable)
  --no-lift-shaped      Only lift explicit $$value markers (skip shaped token auto-lift)
  --no-scrub            Disable scrubbing held values from agent output updates
  -v, --version         Print version
  -h, --help            Print help
`;

function nextArg(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value) {
    process.stderr.write(`secret-scratch: missing value for ${flag}\n`);
    process.exit(2);
  }
  return value;
}

function resolveSelfEntryPath(): string {
  const selfPath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(selfPath);
  } catch {
    return selfPath;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return;
  }
  if (argv[0] === '-v' || argv[0] === '--version') {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }

  const subcommand = argv[0];

  if (subcommand === 'mcp') {
    let dir = DEFAULT_DIR;
    let thread = 'default';
    let cwd: string | undefined;
    let allowCrossThread = false;
    for (let i = 1; i < argv.length; i += 1) {
      const arg = argv[i] ?? '';
      if (arg === '--dir') {
        dir = nextArg(argv, i, '--dir');
        i += 1;
      } else if (arg === '--thread') {
        thread = nextArg(argv, i, '--thread');
        i += 1;
      } else if (arg === '--cwd') {
        cwd = nextArg(argv, i, '--cwd');
        i += 1;
      } else if (arg === '--allow-cross-thread') {
        allowCrossThread = true;
      } else {
        process.stderr.write(`secret-scratch mcp: unknown option ${arg}\n`);
        process.exit(2);
      }
    }
    const pad = new SecretScratchPad(dir);
    await serveSecretScratchMcp({
      pad,
      thread,
      cwd,
      serverVersion: PACKAGE_VERSION,
      allowCrossThread,
    });
    return;
  }

  if (subcommand === 'list') {
    let dir = DEFAULT_DIR;
    let thread: string | undefined;
    for (let i = 1; i < argv.length; i += 1) {
      const arg = argv[i] ?? '';
      if (arg === '--dir') {
        dir = nextArg(argv, i, '--dir');
        i += 1;
      } else if (arg === '--thread') {
        thread = nextArg(argv, i, '--thread');
        i += 1;
      } else {
        process.stderr.write(`secret-scratch list: unknown option ${arg}\n`);
        process.exit(2);
      }
    }
    const pad = new SecretScratchPad(dir);
    process.stdout.write(`${JSON.stringify(pad.list(thread), null, 2)}\n`);
    return;
  }

  if (subcommand === 'clear') {
    const thread = argv[1];
    if (!thread || thread.startsWith('-')) {
      process.stderr.write('secret-scratch clear: thread id required\n');
      process.exit(2);
    }
    let dir = DEFAULT_DIR;
    for (let i = 2; i < argv.length; i += 1) {
      const arg = argv[i] ?? '';
      if (arg === '--dir') {
        dir = nextArg(argv, i, '--dir');
        i += 1;
      } else {
        process.stderr.write(`secret-scratch clear: unknown option ${arg}\n`);
        process.exit(2);
      }
    }
    const pad = new SecretScratchPad(dir);
    pad.clear(thread);
    return;
  }

  const sepIndex = argv.indexOf('--');
  const flagArgs = sepIndex >= 0 ? argv.slice(0, sepIndex) : argv;
  const cmdArgs = sepIndex >= 0 ? argv.slice(sepIndex + 1) : [];

  let dir = DEFAULT_DIR;
  let liftShaped = true;
  let scrubOutput = true;
  const privatePaths: string[] = [];

  for (let i = 0; i < flagArgs.length; i += 1) {
    const arg = flagArgs[i] ?? '';
    if (arg === '--dir') {
      dir = nextArg(flagArgs, i, '--dir');
      i += 1;
    } else if (arg === '--private') {
      privatePaths.push(nextArg(flagArgs, i, '--private'));
      i += 1;
    } else if (arg === '--no-lift-shaped') {
      liftShaped = false;
    } else if (arg === '--no-scrub') {
      scrubOutput = false;
    } else if (sepIndex < 0 && !arg.startsWith('-')) {
      cmdArgs.push(...flagArgs.slice(i));
      break;
    } else {
      process.stderr.write(`secret-scratch: unknown option ${arg}\n`);
      process.exit(2);
    }
  }

  if (cmdArgs.length === 0) {
    process.stderr.write('secret-scratch: expected an ACP agent command after --\n');
    process.stderr.write(HELP);
    process.exit(2);
  }

  const [agentCommand, ...agentArgs] = cmdArgs as [string, ...string[]];
  const cliScript = resolveSelfEntryPath();
  const pad = new SecretScratchPad(dir);
  const exitCode = await runAcpProxy({
    pad,
    agentCommand,
    agentArgs,
    mcpCommand: process.execPath,
    mcpArgs: [cliScript, 'mcp'],
    liftShaped,
    scrubOutput,
    privatePaths,
  });
  process.exitCode = exitCode;
}

void main();
