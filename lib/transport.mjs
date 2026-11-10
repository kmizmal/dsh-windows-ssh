import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 500;
const MAX_TIMER_MS = 2_147_483_647;
// Windows CreateProcess limits the whole remote command to 32767 characters.
const INLINE_LIMIT = 8000;
// Attachment record: one line of JSON describing the file. Anything larger is not a record.
const DEFAULT_ATTACHMENT_RECORD_BYTES = 64 * 1024;
const UTF8 = '[System.Text.UTF8Encoding]::new($false)';

/**
 * Every remote PowerShell invocation is built from this one argv. -NoProfile is not a caller
 * convention but a transport invariant: the target profile loads oh-my-posh
 * (C:\Users\<user>\ohmyposh_init.ps1), which throws MethodInvocationException under a
 * non-interactive SSH session and contaminates both streams. The two pre-NoProfile generations
 * of this plugin relied on the caller remembering the flag, and windows_py silently lost its
 * JSON contract whenever one did not.
 */
const PWSH_ARGS = ['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'];

/**
 * Reads the host OEM code page and reports it as $env:DSH_OEMCP. The console itself stays
 * UTF-8; callers that must run one GBK-emitting native tool switch the console inside a scope.
 */
const OEMCP_PROBE =
  'try{$__dshOem=[int](Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage" -Name OEMCP -ErrorAction Stop).OEMCP}catch{$__dshOem=65001};\n';

/**
 * Prepended to every remote PowerShell payload.
 *
 * One console setting cannot serve both directions, which is what two earlier attempts got
 * wrong in opposite ways:
 *
 * - PowerShell -> SSH *is* governed by Console::OutputEncoding. Measured byte-for-byte on a
 *   CP936 host: with Console=UTF8 a Chinese string emits `e4 b8 ad e6 96 87`, with
 *   Console=936 the same string emits `d6 d0 ce c4`. Since decodePrefix() reads the stream as
 *   UTF-8, an OEM console page turns every JSON response into silent mojibake - JSON.parse
 *   still succeeds, so windows_read/write/replace would all return corrupted paths.
 * - Native child -> PowerShell is decoded with the same Console::OutputEncoding. Those
 *   children (ipconfig, cmd) emit bytes in the *system OEM page*, so under Console=UTF8 the
 *   native output is mis-decoded: `ipconfig` yielded English "IPv4 Address. . ." plus U+FFFD.
 *
 * The JSON contract wins, because every tool in this plugin returns JSON. So the console stays
 * UTF-8, the OEM page is only *reported* through $env:DSH_OEMCP, and callers that need one
 * native GBK tool switch the console inside a scope and restore it (documented in
 * docs/windows-exec-guide.md). `chcp` is not used at all: it does not affect a native tool's
 * source page, and `chcp.com 65001>$null` silently passes "65001>" as an argument.
 *
 * PYTHONUTF8 is deliberately NOT exported here: under a UTF-8 console a GBK python is decoded
 * correctly, while a UTF-8 python would be fine too - but the exec channel must not silently
 * change a user script's interpreter defaults. The python channel pins both sides explicitly;
 * see PYTHON_PREAMBLE.
 *
 * Idempotent, silent, and it leaves $ErrorActionPreference alone: a preamble that changed error
 * handling would silently alter the exit status of every user script.
 */
export const PREAMBLE =
  OEMCP_PROBE +
  '$env:DSH_OEMCP=[string]$__dshOem;\n' +
  '[Console]::OutputEncoding=' + UTF8 + ';\n' +
  '$OutputEncoding=' + UTF8 + ';\n' +
  'try{[Console]::InputEncoding=' + UTF8 + '}catch{};\n' +
  "$ProgressPreference='SilentlyContinue';\n" +
  "try{$PSStyle.OutputRendering='PlainText'}catch{};\n" +
  'Remove-Variable __dshOem -ErrorAction SilentlyContinue;\n';

/**
 * Prepended to every Python payload.
 *
 * Python owns both directions of its own stdio, so this channel pins the whole path to UTF-8:
 * the console pages, PYTHONUTF8 and PYTHONIOENCODING. Measured on CP936, this keeps 中文 and
 * even non-BMP emoji (😀) intact, where a GBK python aborts with
 * UnicodeEncodeError: 'gbk' codec can't encode character '\U0001f600'.
 */
export const PYTHON_PREAMBLE =
  '[Console]::OutputEncoding=' + UTF8 + ';\n' +
  '$OutputEncoding=' + UTF8 + ';\n' +
  'try{[Console]::InputEncoding=' + UTF8 + '}catch{};\n' +
  "$ProgressPreference='SilentlyContinue';\n" +
  "try{$PSStyle.OutputRendering='PlainText'}catch{};\n" +
  "$env:PYTHONUTF8='1';\n" +
  "$env:PYTHONIOENCODING='utf-8';\n";

/** Interpreters probed in order. The Store shims (python.exe/python3.exe) fail --version. */
export const DEFAULT_PYTHON_CANDIDATES = ['py -3.14', 'py -3', 'python', 'python3'];

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

function destinationArgs(config) {
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
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=' + connectTimeout, '-p', String(port), '-l', user];
  if (config.identityFile !== undefined) args.push('-i', nonemptyString(config.identityFile, 'identityFile'));
  args.push('--', host);
  return args;
}

function encode(remote, preamble = PREAMBLE) {
  return Buffer.from(preamble + remote, 'utf16le').toString('base64');
}

/** Build literal argv for OpenSSH. No script or path is interpolated into a local shell. */
export function buildSshArgs(config, script) {
  const args = destinationArgs(config);
  if (typeof script !== 'string') throw new TypeError('script must be a string');
  // Large helpers travel over UTF-8 stdin, executed by a short encoded bootstrap.
  const source = script.length > INLINE_LIMIT
    ? '[Console]::InputEncoding = ' + UTF8 + '; & ([ScriptBlock]::Create([Console]::In.ReadToEnd()))'
    : script;
  args.push(...PWSH_ARGS, encode(source));
  return args;
}

function pythonList(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) {
    throw new TypeError('pythonCandidates must be a nonempty array');
  }
  return candidates.map(candidate => {
    if (typeof candidate !== 'string' || !/^[A-Za-z0-9_.\\/-]+( [A-Za-z0-9_.\\/-]+)*$/.test(candidate)) {
      throw new TypeError('pythonCandidates entries must be plain command names, optionally with one version argument');
    }
    return "'" + candidate + "'";
  }).join(',');
}

/**
 * Fixed bootstrap that executes a Python program read from stdin. The program itself never
 * reaches the command line, so quoting and the 32767-character limit stay irrelevant.
 *
 * Expects PYTHON_PREAMBLE to have run: it owns the encoding setup for this channel.
 * The candidate probe rejects an App Execution Alias placeholder, which exits 9009 with no
 * output under a noninteractive session, by requiring real `Python <version>` text.
 */
export function buildPythonBootstrap(candidates = DEFAULT_PYTHON_CANDIDATES) {
  return '$__dshSrc=[Console]::In.ReadToEnd();\n' +
    '$__dshExe=$null;$__dshPre=@();\n' +
    'foreach($__dshCand in @(' + pythonList(candidates) + ')){\n' +
    '$__dshParts=@($__dshCand -split " ");$__dshTry=@();\n' +
    'if($__dshParts.Count -gt 1){$__dshTry=@($__dshParts[1..($__dshParts.Count-1)])}\n' +
    '$global:LASTEXITCODE=0;\n' +
    'try{$__dshOut=(& $__dshParts[0] @__dshTry --version 2>&1|Out-String).Trim()}catch{$__dshOut=""}\n' +
    "if($LASTEXITCODE -eq 0 -and $__dshOut -match '^Python \\d+\\.'){$__dshExe=$__dshParts[0];$__dshPre=$__dshTry;break}\n" +
    '}\n' +
    "if($null -eq $__dshExe){[Console]::Error.WriteLine('DSH_PYTHON_NOT_FOUND');exit 127}\n" +
    '$__dshSrc|& $__dshExe @__dshPre -\n' +
    'exit $LASTEXITCODE\n';
}

/** Build argv that runs a Python program; the source always travels over stdin. */
export function buildPythonArgs(config, source) {
  if (typeof source !== 'string') throw new TypeError('source must be a string');
  const args = destinationArgs(config);
  args.push(...PWSH_ARGS, encode(buildPythonBootstrap(config.pythonCandidates), PYTHON_PREAMBLE));
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
  return runSsh(config, args, script.length > INLINE_LIMIT ? script : undefined, opts);
}

/**
 * Execute a PowerShell payload whose stdout carries an attachment after its record.
 *
 * Same argv, same preamble and the same stdin rule as runPowerShell; the only difference is how
 * stdout is framed (see readAttachment). The result keeps `stdout` = record text and adds
 * `attachment` = the trailing bytes.
 */
export async function runPowerShellAttach(config, script, opts = {}) {
  const args = buildSshArgs(config, script);
  return runSsh(config, args, script.length > INLINE_LIMIT ? script : undefined, { ...opts, attach: true });
}

/** Execute a Python program through the fixed stdin channel. */
export async function runPython(config, source, opts = {}) {
  const args = buildPythonArgs(config, source);
  return runSsh(config, args, source, opts);
}

/**
 * How an attachment-capable run frames its stdout.
 *
 * `record` alone, exactly once: a 32-bit big-endian header with the record length, the UTF-8
 * record (one line of JSON), then every remaining byte is the attachment. The header is what
 * makes splitting data from text structural rather than a guess - the remote writes the record
 * in one `Out-String` call, so its length is known before any file byte is written, and a
 * corrupted or truncated stream fails the length check instead of silently shifting the
 * boundary.
 *
 * 4 bytes + record + attachment is also why this path does not share the JSON output budget:
 * `maxOutputBytes` exists to stop a runaway *response* from filling memory, and an attachment is
 * a file whose size the caller already bounds with `maxBytes`.
 */
function readAttachment(stdout, maxRecordBytes) {
  const chunks = Array.isArray(stdout) ? stdout : null;
  const size = chunks ? chunks.reduce((n, chunk) => n + chunk.length, 0) : 0;
  if (!chunks || size < 4) return { record: null, data: null };
  const head = Buffer.concat(chunks, Math.min(size, 4));
  const length = head.readUInt32BE(0);
  if (length < 2 || length > maxRecordBytes || 4 + length > size) return { record: null, data: null };
  const all = Buffer.concat(chunks);
  return { record: all.subarray(4, 4 + length).toString('utf8'), data: all.subarray(4 + length) };
}

async function runSsh(config, args, stdinText, opts = {}) {
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
    child.stdin.end(stdinText, 'utf8');
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
      // Attachment mode owns stdout: the bytes are the file, not a response, so they bypass the
      // response budget and are retained whole (the caller caps them with maxBytes).
      if (isStdout && opts.attach) {
        target.push(chunk);
        stdoutBytes += chunk.length;
        return;
      }
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
      if (opts.attach) {
        const framed = readAttachment(stdout, integer(opts.maxRecordBytes ?? DEFAULT_ATTACHMENT_RECORD_BYTES, 'maxRecordBytes', 2));
        result.stdout = framed.record ?? '';
        result.attachment = framed.data;
        result.exitCode = exitCode;
        result.signal = signal;
        result.remoteStateUnknown ||= signal !== null || exitCode === 255;
        resolve(result);
        return;
      }
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
