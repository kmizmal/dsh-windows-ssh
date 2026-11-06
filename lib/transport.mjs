import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 500;
const MAX_TIMER_MS = 2_147_483_647;

function integer(value, name, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(name + ' must be an integer between ' + min + ' and ' + max);
  }
  return value;
}

function nonemptyString(value, name) {
  if (typeof value !== 'string' || !value.length || value.includes('\0')) {
    throw new TypeError(name + ' must be a nonempty string without NUL');
  }
  return value;
}

/** Build literal argv for OpenSSH. No script or path is interpolated into a local shell. */
export function buildSshArgs(config, script) {
  if (!config || typeof config !== 'object') throw new TypeError('config is required');
  const { host, user } = config;
  // Conservative destination syntax prevents options, user@host parsing, and URI interpretation.
  if (typeof host !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(host)) {
    throw new TypeError('host must be a hostname or IP address without options or whitespace');
  }
  if (typeof user !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.\\-]*\$?$/.test(user)) {
    throw new TypeError('user contains unsupported characters or starts with an option');
  }
  const port = integer(config.port ?? 22, 'port', 1, 65535);
  const connectTimeout = integer(config.connectTimeoutSeconds ?? 10, 'connectTimeoutSeconds', 1, MAX_TIMER_MS);
  if (typeof script !== 'string') throw new TypeError('script must be a string');
  const prefix = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);\n' +
    '$OutputEncoding = [System.Text.UTF8Encoding]::new($false);\n';
  // Windows CreateProcess limits the whole remote command to 32767 characters.
  // Large helpers travel over UTF8 stdin, executed by a short encoded bootstrap.
  const source = script.length > 8000
    ? '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); & ([ScriptBlock]::Create([Console]::In.ReadToEnd()))'
    : script;
  const encoded = Buffer.from(prefix + source, 'utf16le').toString('base64');
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=' + connectTimeout, '-p', String(port), '-l', user];
  if (config.identityFile !== undefined) args.push('-i', nonemptyString(config.identityFile, 'identityFile'));
  args.push('--', host, 'pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded);
  return args;
}

function emptyResult() {
  return { stdout: '', stderr: '', exitCode: null, signal: null, timedOut: false,
    aborted: false, truncated: false, remoteStateUnknown: false };
}

// Streaming decode deliberately leaves an incomplete final code point buffered. It is
// omitted instead of emitting a replacement character introduced by our output limit.
function decodePrefix(chunks, length, budget) {
  const text = new TextDecoder('utf-8').decode(Buffer.concat(chunks, length), { stream: true });
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= budget) return text;
  return new TextDecoder('utf-8').decode(encoded.subarray(0, budget), { stream: true });
}

/**
 * Execute encoded PowerShell over a local OpenSSH child. Nonzero SSH/remote exits
 * resolve; invalid input and spawn failures reject. timeoutMs=0 disables the timer.
 * Output budget is shared across stdout/stderr; excess bytes are drained/discarded.
 * Killing SSH never proves that an already-started remote process has stopped.
 */
export async function runPowerShell(config, script, opts = {}) {
  const args = buildSshArgs(config, script);
  const binary = nonemptyString(config.sshBinary ?? 'ssh', 'sshBinary');
  const maxOutputBytes = integer(config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 'maxOutputBytes', 0);
  const timeoutMs = integer(opts.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs', 0, MAX_TIMER_MS);
  const abortSignal = opts.signal;
  if (abortSignal !== undefined && (!(abortSignal instanceof AbortSignal))) {
    throw new TypeError('signal must be an AbortSignal');
  }
  const result = emptyResult();
  if (abortSignal?.aborted) return { ...result, aborted: true };

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    // Early SSH failures can close stdin before a large script has been sent.
    child.stdin.on('error', () => {});
    child.stdin.end(script.length > 8000 ? script : undefined, 'utf8');
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let capturedBytes = 0;
    let timer;
    let escalation;
    let drainTimer;
    let settled = false;
    let exited = false;

    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(escalation);
      clearTimeout(drainTimer);
      abortSignal?.removeEventListener('abort', onAbort);
    };
    const closeInheritedPipes = () => {
      drainTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, KILL_GRACE_MS);
    };
    const stop = reason => {
      if (settled || result.timedOut || result.aborted) return;
      result[reason] = true;
      result.remoteStateUnknown = true;
      if (exited) {
        closeInheritedPipes();
        return;
      }
      child.kill('SIGTERM');
      escalation = setTimeout(() => {
        if (!exited && !settled) child.kill('SIGKILL');
      }, KILL_GRACE_MS);
    };
    const onAbort = () => stop('aborted');
    const capture = (chunk, target, isStdout) => {
      const remaining = maxOutputBytes - capturedBytes;
      const count = Math.min(remaining, chunk.length);
      if (count < chunk.length) result.truncated = true;
      if (count) {
        // Copy the retained slice so a tiny prefix cannot retain a large backing buffer.
        target.push(Buffer.from(chunk.subarray(0, count)));
        capturedBytes += count;
        if (isStdout) stdoutBytes += count;
        else stderrBytes += count;
      }
    };
    child.stdout.on('data', chunk => capture(chunk, stdout, true));
    child.stderr.on('data', chunk => capture(chunk, stderr, false));
    child.once('error', error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once('exit', () => {
      exited = true;
      clearTimeout(escalation);
      // A local descendant can inherit pipes. Cancellation must not wait forever
      // for that unrelated process after the SSH child itself has exited.
      if (result.timedOut || result.aborted) {
        closeInheritedPipes();
      }
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      result.stdout = decodePrefix(stdout, stdoutBytes, maxOutputBytes);
      result.stderr = decodePrefix(stderr, stderrBytes, maxOutputBytes - Buffer.byteLength(result.stdout));
      result.exitCode = exitCode;
      result.signal = signal;
      result.remoteStateUnknown ||= signal !== null || exitCode === 255;
      resolve(result);
    });
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs > 0) timer = setTimeout(() => stop('timedOut'), timeoutMs);
    // Covers an abort racing listener registration without spawning a second child.
    if (abortSignal?.aborted) onAbort();
  });
}
