import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config';

export const PHONE_ROOT = '/storage/emulated/0';

export type AdbRequest =
  | { op: 'devices' }
  | { op: 'getprop'; serial: string; property: string }
  | { op: 'df'; serial: string; path: string }
  | { op: 'list-paths'; serial: string; root: string }
  | { op: 'stat'; serial: string; paths: string[] }
  | { op: 'list-special'; serial: string; root: string }
  | { op: 'sha256'; serial: string; paths: string[] }
  | { op: 'pull'; serial: string; remote: string; local: string };

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Builds the adb argv for a request. These templates are the only commands the CLI can send. */
export function adbArgs(request: AdbRequest): string[] {
  switch (request.op) {
    case 'devices':
      return ['devices', '-l'];
    case 'getprop':
      if (!/^[a-z0-9._]+$/i.test(request.property)) throw new Error(`invalid property ${request.property}`);
      return ['-s', request.serial, 'shell', `getprop ${request.property}`];
    case 'df':
      return ['-s', request.serial, 'shell', `df -k ${quote(request.path)}`];
    case 'list-paths':
      return ['-s', request.serial, 'shell', `find ${quote(request.root)} -type f`];
    case 'stat':
      return ['-s', request.serial, 'shell', `stat -c '%s|%Y|%n' -- ${request.paths.map(quote).join(' ')}`];
    case 'list-special':
      return ['-s', request.serial, 'shell', `find ${quote(request.root)} ! -type f ! -type d`];
    case 'sha256':
      return ['-s', request.serial, 'shell', `sha256sum -- ${request.paths.map(quote).join(' ')}`];
    case 'pull':
      return ['-s', request.serial, 'pull', '-a', request.remote, request.local];
  }
}

const allowedShellPrograms = ['getprop', 'df', 'find', 'stat', 'sha256sum'];
const forbiddenWords =
  /(^|[\s'"])(rm|rmdir|mv|cp|dd|chmod|chown|touch|mkdir|ln|truncate|setprop|pm|am|svc|reboot|input|content|cmd|settings|sh|su|tee|-delete|-exec|-execdir|-ok|-fprint)(?=[\s'"]|$)/;

function stripQuoted(command: string): string {
  return command.replace(/'(?:[^']|'\\'')*'/g, "''");
}

/** Second line of defence: rejects any argv that is not a read-only operation. */
export function assertAllowed(args: string[]): void {
  const fail = (reason: string): never => {
    throw new Error(`refusing adb command (${reason}): adb ${args.join(' ')}`);
  };
  if (args[0] === 'devices') {
    if (args.length > 2 || (args[1] !== undefined && args[1] !== '-l')) fail('unexpected arguments');
    return;
  }
  if (args[0] !== '-s' || !args[1] || args[1].startsWith('-')) fail('a device serial is required');
  const verb = args[2];
  if (verb === 'pull') {
    if (args.length !== 6 || args[3] !== '-a') fail('pull must be `pull -a <remote> <local>`');
    if (!args[4]!.startsWith('/')) fail('remote path must be absolute');
    return;
  }
  if (verb !== 'shell') return fail(`verb ${String(verb)} is not allowed`);
  if (args.length !== 4) fail('shell takes exactly one command string');
  const command = args[3]!;
  const program = command.split(/\s+/, 1)[0]!;
  if (!allowedShellPrograms.includes(program)) fail(`program ${program} is not allowed`);
  const unquoted = stripQuoted(command);
  if (/[;&|<>`$\\\n]/.test(unquoted)) fail('shell metacharacters are not allowed');
  if (forbiddenWords.test(unquoted)) fail('command contains a write operation');
}

export function adbBinary(): string {
  const candidates = [
    config.adbPath,
    join(homedir(), '.local/opt/platform-tools/adb'),
    join(homedir(), 'Android/Sdk/platform-tools/adb'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate)) ?? 'adb';
}

export interface AdbResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function runAdb(
  request: AdbRequest,
  options: { onStdoutLine?: (line: string) => void; signal?: AbortSignal } = {},
): Promise<AdbResult> {
  const args = adbArgs(request);
  assertAllowed(args);
  return new Promise((resolve, reject) => {
    const child = spawn(adbBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'], signal: options.signal });
    let stdout = '';
    let stderr = '';
    let partial = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (options.onStdoutLine) {
        partial += chunk;
        const lines = partial.split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) options.onStdoutLine(line);
      } else {
        stdout += chunk;
      }
    });
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) =>
      reject(
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error('adb not found. Install platform-tools (docs/setup/phase-0-aws-setup.md §0.1).')
          : error,
      ),
    );
    child.on('close', (code) => {
      if (partial && options.onStdoutLine) options.onStdoutLine(partial);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

export interface AdbDevice {
  serial: string;
  state: string;
  model?: string;
}

export function parseDevices(output: string): AdbDevice[] {
  return output
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial = '', state = '', ...rest] = line.split(/\s+/);
      const model = rest.find((part) => part.startsWith('model:'))?.slice('model:'.length);
      return { serial, state, ...(model ? { model } : {}) };
    });
}

export interface PhoneFileStat {
  path: string;
  size: number;
  mtimeSeconds: number;
}

/** Parses `stat -c '%s|%Y|%n'` lines. Returns null for lines that don't parse (e.g. a newline in a name). */
export function parseStatLine(line: string): PhoneFileStat | null {
  const match = /^(\d+)\|(\d+)\|(\/.*)$/.exec(line);
  if (!match) return null;
  return { size: Number(match[1]), mtimeSeconds: Number(match[2]), path: match[3]! };
}

export function parseSha256Line(line: string): { sha256: string; path: string } | null {
  const match = /^([0-9a-f]{64}) [ *](\/.*)$/.exec(line);
  return match ? { sha256: match[1]!, path: match[2]! } : null;
}

export function parseDf(output: string): { totalBytes: number; usedBytes: number; freeBytes: number } | null {
  const line = output.trim().split('\n').at(-1)?.trim().split(/\s+/);
  if (!line || line.length < 4) return null;
  const [, total, used, free] = line.map(Number);
  if (![total, used, free].every((value) => Number.isFinite(value))) return null;
  return { totalBytes: total! * 1024, usedBytes: used! * 1024, freeBytes: free! * 1024 };
}

/** The one connected, authorised phone (or the one with `serial`), with a clear message otherwise. */
export async function pickDevice(serial?: string): Promise<AdbDevice> {
  const { stdout } = await runAdb({ op: 'devices' });
  const devices = parseDevices(stdout);
  const usable = devices.filter((device) => device.state === 'device');
  if (serial) {
    const match = devices.find((device) => device.serial === serial);
    if (!match) throw new Error(`device ${serial} is not connected`);
    if (match.state !== 'device')
      throw new Error(`device ${serial} is ${match.state}; unlock it and accept the prompt`);
    return match;
  }
  if (usable.length === 1) return usable[0]!;
  if (usable.length > 1)
    throw new Error(
      `several devices connected; pick one with --serial (${usable.map((d) => d.serial).join(', ')})`,
    );
  if (devices.some((device) => device.state === 'unauthorized')) {
    throw new Error(
      'the phone has not authorised this computer yet: unlock it and tap Allow on the USB debugging prompt',
    );
  }
  throw new Error(
    'no phone found over adb. Turn on USB debugging (docs/setup/phase-0-aws-setup.md §0.2), reconnect the cable, then run `vault phone devices`.',
  );
}
