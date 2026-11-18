import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readEnvFile } from './env.js';

const runtime = readEnvFile(['APP_RUNTIME']).APP_RUNTIME || 'unified';
if (runtime !== 'unified') {
  throw new Error(
    'APP_RUNTIME must be unified. Start the application with npm run dev.',
  );
}

const runningCompiled = path
  .resolve(process.argv[1] || '')
  .includes(path.sep + 'dist' + path.sep);
const tsxCli = path.resolve('node_modules/tsx/dist/cli.mjs');
const lockPath = path.resolve('store', 'unified-app.lock');
fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

try {
  const existingPid = Number(fs.readFileSync(lockPath, 'utf8').trim());
  if (processIsAlive(existingPid)) {
    console.log(
      'Andy is already running (PID ' +
        existingPid +
        '). Reuse the existing dashboard and WhatsApp connection.',
    );
    process.exit(0);
  }
  fs.unlinkSync(lockPath);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

let lockFd: number;
try {
  lockFd = fs.openSync(lockPath, 'wx', 0o600);
  fs.writeFileSync(lockFd, String(process.pid));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
    console.log(
      'Andy startup is already in progress. Not starting a second instance.',
    );
    process.exit(0);
  }
  throw error;
}

process.on('exit', () => {
  try {
    const lockPid = Number(fs.readFileSync(lockPath, 'utf8').trim());
    if (lockPid === process.pid) fs.unlinkSync(lockPath);
  } catch {
    /* Lock may already have been cleared. */
  }
});
const children: ChildProcess[] = [];
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals | 'child-exit' = 'SIGTERM'): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill(signal === 'child-exit' ? 'SIGTERM' : signal);
  }
}

function start(name: string, sourceEntry: string): ChildProcess {
  const entry = runningCompiled
    ? path.resolve(
        'dist',
        sourceEntry.replace(/^src\//, '').replace(/\.ts$/, '.js'),
      )
    : path.resolve(sourceEntry);
  const child = spawn(
    process.execPath,
    runningCompiled ? [entry] : [tsxCli, entry],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    },
  );
  children.push(child);
  child.on('error', (error) => {
    console.error(name + ' failed to start:', error);
    shutdown();
  });
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error(
        name +
          ' stopped unexpectedly (code=' +
          code +
          ', signal=' +
          signal +
          '). Shutting down the other service.',
      );
      shutdown();
      process.exitCode = code ?? 1;
    }
  });
  return child;
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log(
  'Starting Andy unified application (dashboard + one WhatsApp LinkedIn bot).',
);
start('Dashboard', 'src/platform-server.ts');
start('LinkedIn WhatsApp bot', 'src/linkedin-bot.ts');
