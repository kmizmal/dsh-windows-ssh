import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEventListeners } from "node:events";
import { spawnSync } from "node:child_process";

const config = { host: 'example.invalid', user: 'windows-user', port: 20022 };
const load = () => import('../lib/transport.mjs');

async function fakeSsh(t, source) {
  const dir = await mkdtemp(join(tmpdir(), 'windows-ssh-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'fake ssh');
  await writeFile(path, '#!' + process.execPath + '\n' + source);
  await chmod(path, 0o700);
  return { ...config, sshBinary: path };
}

test('transport module exports the public functions', async () => {
  const api = await load();
  assert.equal(typeof api.runPowerShell, 'function');
  assert.equal(typeof api.buildSshArgs, 'function');
});

test('SSH arguments protect host keys and preserve Unicode script without shell parsing', async () => {
  const { buildSshArgs } = await load();
  const script = 'Write-Output "中文 C:\\my folder\\file; $value"';
  const args = buildSshArgs({ ...config, identityFile: '/tmp/key with spaces', connectTimeoutSeconds: 7 }, script);
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.ok(args.includes('ConnectTimeout=7'));
  assert.equal(args[args.indexOf('-p') + 1], '20022');
  assert.equal(args[args.indexOf('-l') + 1], 'windows-user');
  assert.equal(args[args.indexOf('-i') + 1], '/tmp/key with spaces');
  const hostIndex = args.indexOf(config.host);
  assert.ok(hostIndex > 0);
  const remote = args.slice(hostIndex + 1).join(' ');
  assert.match(remote, /^pwsh -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  const decoded = Buffer.from(remote.split(' ').at(-1), 'base64').toString('utf16le');
  // The console stays UTF-8: decodePrefix() reads the SSH stream as UTF-8, so an OEM console
  // page would silently corrupt every JSON response while JSON.parse still succeeded.
  assert.match(decoded, /\[Console\]::OutputEncoding\s*=\s*\[System\.Text\.UTF8Encoding\]/);
  assert.match(decoded, /\$OutputEncoding\s*=/);
  assert.match(decoded, /UTF8Encoding/);
  assert.match(decoded, /-Name OEMCP/);
  assert.match(decoded, /\$env:DSH_OEMCP=/);
  // The PowerShell channel must not export these: only the python channel pins them.
  assert.doesNotMatch(decoded, /PYTHONUTF8/);
  assert.doesNotMatch(decoded, /PYTHONIOENCODING/);
  assert.doesNotMatch(decoded, /chcp/);
  assert.doesNotMatch(decoded, /GetEncoding\(\$__dshOem\)/);
  assert.ok(decoded.endsWith(script));
});

test('unsafe destination and invalid limits reject before execution', async () => {
  const { buildSshArgs, runPowerShell } = await load();
  for (const host of ['-oProxyCommand=evil', 'host name', 'user@host', 'host;evil', 'host\nname', '']) {
    assert.throws(() => buildSshArgs({ ...config, host }, 'echo ok'), /host/i);
  }
  for (const user of ['-root', 'a b', 'a@b', 'a;evil', 'a\nname', '']) {
    assert.throws(() => buildSshArgs({ ...config, user }, 'echo ok'), /user/i);
  }
  for (const port of [0, 65536, 1.5, '22', NaN]) {
    assert.throws(() => buildSshArgs({ ...config, port }, 'echo ok'), /port/i);
  }
  for (const [key, value] of [['maxOutputBytes', -1], ['timeoutMs', Infinity], ['connectTimeoutSeconds', 0]]) {
    await assert.rejects(runPowerShell({ ...config, [key]: value }, ''), new RegExp(key, 'i'));
  }
});

test('captures stdout stderr and a remote nonzero exit through a real local process', async t => {
  const { runPowerShell } = await load();
  const cfg = await fakeSsh(t, 'process.stdout.write("中文😀"); process.stderr.write("warning"); process.exitCode = 17;');
  const result = await runPowerShell(cfg, 'Get-Date');
  assert.deepEqual(result, { stdout: '中文😀', stderr: 'warning', exitCode: 17, signal: null, timedOut: false, aborted: false, truncated: false, remoteStateUnknown: false });
});

test('argv is passed literally with no shell and child stdin is closed', async t => {
  const { runPowerShell } = await load();
  const cfg = await fakeSsh(t, 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify(process.argv.slice(2))));');
  const result = await runPowerShell({ ...cfg, identityFile: '/tmp/key $(echo never); quoted' }, '"中文"');
  const argv = JSON.parse(result.stdout);
  assert.equal(argv[argv.indexOf('-i') + 1], '/tmp/key $(echo never); quoted');
  assert.equal(result.exitCode, 0);
});

test('output limit is shared and drops incomplete UTF8 characters at the boundary', async t => {
  const { runPowerShell } = await load();
  const cfg = await fakeSsh(t, 'process.stdout.write(Buffer.from([0x41,0xe4])); setTimeout(() => { process.stdout.write(Buffer.from([0xb8,0xad,0xf0,0x9f,0x98,0x80])); process.stderr.write("more"); }, 10);');
  const result = await runPowerShell({ ...cfg, maxOutputBytes: 6 }, '');
  assert.equal(result.stdout, 'A中');
  assert.equal(result.stderr, '');
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= 6);
  assert.ok(!result.stdout.includes('\ufffd'));
  assert.equal(result.exitCode, 0);
});

test('UTF8 split between chunks survives when within output limit', async t => {
  const { runPowerShell } = await load();
  const cfg = await fakeSsh(t, 'process.stdout.write(Buffer.from([0xe4])); setTimeout(() => process.stdout.write(Buffer.from([0xb8,0xad])), 10);');
  const result = await runPowerShell({ ...cfg, maxOutputBytes: 3 }, '');
  assert.equal(result.stdout, '中');
  assert.equal(result.truncated, false);
});

test('SSH connection error status 255 preserves diagnostics and uncertainty', async t => {
  const { runPowerShell } = await load();
  const cfg = await fakeSsh(t, 'process.stderr.write("Connection lost"); process.exitCode = 255;');
  const result = await runPowerShell(cfg, '');
  assert.equal(result.exitCode, 255);
  assert.equal(result.stderr, 'Connection lost');
  assert.equal(result.remoteStateUnknown, true);
});

test('missing SSH executable rejects with the spawn error', async () => {
  const { runPowerShell } = await load();
  await assert.rejects(runPowerShell({ ...config, sshBinary: '/nonexistent/windows-ssh-test' }, ''), { code: 'ENOENT' });
});

test('pre-aborted request does not spawn and has no remote uncertainty', async () => {
  const { runPowerShell } = await load();
  const controller = new AbortController();
  controller.abort();
  const result = await runPowerShell({ ...config, sshBinary: '/nonexistent/windows-ssh-test' }, '', { signal: controller.signal });
  assert.deepEqual(result, { stdout: '', stderr: '', exitCode: null, signal: null, timedOut: false, aborted: true, truncated: false, remoteStateUnknown: false });
});

test('timeout override kills the local SSH process and reports remote uncertainty', async t => {
  const { runPowerShell } = await load();
  const cfg = await fakeSsh(t, 'setInterval(() => {}, 1000);');
  const started = Date.now();
  const result = await runPowerShell({ ...cfg, timeoutMs: 10000 }, '', { timeoutMs: 100 });
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
  assert.equal(result.remoteStateUnknown, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, 'SIGTERM');
  assert.ok(Date.now() - started < 4000);
});

test('abort terminates local SSH and removes the abort listener', async t => {
  const { runPowerShell } = await load();
  const cfg = await fakeSsh(t, 'setInterval(() => {}, 1000);');
  const controller = new AbortController();
  const request = runPowerShell(cfg, '', { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const result = await request;
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.remoteStateUnknown, true);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('timeout bounds completion when an exited SSH child leaves inherited pipes open', async t => {
  const { runPowerShell } = await load();
  const cfg = await fakeSsh(t, 'const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { stdio: ["ignore", 1, 2] }); child.unref();');
  const started = Date.now();
  const result = await runPowerShell(cfg, '', { timeoutMs: 500 });
  assert.equal(result.timedOut, true);
  assert.equal(result.remoteStateUnknown, true);
  assert.ok(Date.now() - started < 2000);
});

test('zero output budget discards both streams without killing the command', async t => {
  const { runPowerShell } = await load();
  const cfg = await fakeSsh(t, 'process.stdout.write("out"); process.stderr.write("err");');
  const result = await runPowerShell({ ...cfg, maxOutputBytes: 0 }, '');
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(result.truncated, true);
  assert.equal(result.exitCode, 0);
});

test('zero timeout override disables a configured timeout', async t => {
  const { runPowerShell } = await load();
  const cfg = await fakeSsh(t, 'setTimeout(() => process.stdout.write("done"), 100);');
  const result = await runPowerShell({ ...cfg, timeoutMs: 1 }, '', { timeoutMs: 0 });
  assert.equal(result.stdout, 'done');
  assert.equal(result.timedOut, false);
});

test('ignored SIGTERM is escalated to SIGKILL', async t => {
  const { runPowerShell } = await load();
  const cfg = await fakeSsh(t, 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);');
  const result = await runPowerShell(cfg, '', { timeoutMs: 400 });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.remoteStateUnknown, true);
});

test('preamble probes OEMCP, stays silent, and never exports python settings into exec', async () => {
  const { PREAMBLE } = await load();
  // OEMCP is probed from the registry, not hardcoded, and falls back to UTF-8 on failure.
  assert.match(PREAMBLE, /HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage/);
  assert.match(PREAMBLE, /-Name OEMCP/);
  assert.match(PREAMBLE, /catch\{\$__dshOem=65001\}/m, 'a failed probe must fall back to UTF-8');
  // The transport decodes SSH as UTF-8, so PowerShell output must stay UTF-8.
  assert.match(PREAMBLE, /\[Console\]::OutputEncoding=\[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
  assert.match(PREAMBLE, /\$OutputEncoding=\[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
  // Progress/ANSI noise suppression, with the PS5 guard around $PSStyle.
  assert.match(PREAMBLE, /\$ProgressPreference='SilentlyContinue'/);
  assert.match(PREAMBLE, /try\{\$PSStyle\.OutputRendering='PlainText'\}catch\{\}/);
  // Defaults that would change user script semantics must not be touched.
  assert.doesNotMatch(PREAMBLE, /ErrorActionPreference/);
  assert.doesNotMatch(PREAMBLE, /chcp/);
  assert.doesNotMatch(PREAMBLE, /PYTHONUTF8|PYTHONIOENCODING/);
  // Every statement must be side-effect free: no bare expression can emit to stdout.
  for (const line of PREAMBLE.split('\n').filter(Boolean)) {
    assert.match(line, /^(try\{|if\(|\$|\[|[A-Za-z]|\})/, 'unexpected statement: ' + line);
  }
});

test('python preamble pins both directions to UTF-8 and sets the python env', async () => {
  const { PYTHON_PREAMBLE, buildPythonArgs, PREAMBLE } = await load();
  assert.match(PYTHON_PREAMBLE, /\[Console\]::OutputEncoding=\[System\.Text\.UTF8Encoding\]::new/);
  assert.match(PYTHON_PREAMBLE, /\$env:PYTHONUTF8='1'/);
  assert.match(PYTHON_PREAMBLE, /\$env:PYTHONIOENCODING='utf-8'/);
  assert.match(PYTHON_PREAMBLE, /\$ProgressPreference='SilentlyContinue'/);
  const args = buildPythonArgs({ ...config }, 'print(1)');
  // -NoProfile is a transport invariant on every pwsh channel, not a caller convention: the
  // remote profile loads oh-my-posh and throws on a non-interactive session.
  assert.match(args.slice(args.indexOf(config.host) + 1).join(' '),
    /^pwsh -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  const encoded = args[args.length - 1];
  const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.ok(decoded.startsWith(PYTHON_PREAMBLE), 'python must use its own preamble');
  assert.ok(!decoded.includes('$env:DSH_OEMCP'), 'the python channel does not probe OEMCP');
  assert.ok(decoded.endsWith('exit $LASTEXITCODE\n'), 'native exit codes must propagate');
  // The program never reaches the command line: only the fixed bootstrap is encoded.
  assert.ok(!decoded.includes('print(1)'));
  assert.ok(!args.join(' ').includes('print(1)'));
});

test('python bootstrap probes interpreters in order and rejects Store placeholders', async () => {
  const { buildPythonBootstrap, DEFAULT_PYTHON_CANDIDATES } = await load();
  assert.deepEqual(DEFAULT_PYTHON_CANDIDATES, ['py -3.14', 'py -3', 'python', 'python3']);
  const boot = buildPythonBootstrap();
  // Ordered probe, and version text is the evidence: a Store alias exits 9009 with no output.
  assert.ok(boot.indexOf("'py -3.14'") < boot.indexOf("'python3'"));
  assert.match(boot, /--version/);
  assert.match(boot, /\^Python \\d\+\\\./);
  assert.match(boot, /DSH_PYTHON_NOT_FOUND/);
  assert.match(boot, /exit 127/);
  // The program travels on stdin, so argv must never carry it.
  assert.match(boot, /\[Console\]::In\.ReadToEnd\(\)/);
  assert.match(boot, /\|& \$__dshExe @__dshPre -/);
});

test('python bootstrap validates candidate names against command injection', async () => {
  const { buildPythonBootstrap } = await load();
  for (const bad of [[], ['py -3.14; whoami'], ['py $(whoami)'], ["py 'x'"], ['py -3 ] ; evil'], [5]]) {
    assert.throws(() => buildPythonBootstrap(bad), /pythonCandidates/);
  }
  assert.equal(buildPythonBootstrap(['py -3.14']).includes("'py -3.14'"), true);
});

test('runPython sends the source on stdin and propagates the interpreter exit code', async t => {
  const { runPython } = await load();
  // Fake ssh captures stdin (the program) and exits 4 the way python would.
  const cfg = await fakeSsh(t, 'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{process.stdout.write("got:"+data);process.exitCode=4});');
  const result = await runPython(cfg, 'import sys\nsys.exit(4)\n');
  assert.equal(result.stdout, 'got:import sys\nsys.exit(4)\n');
  assert.equal(result.exitCode, 4);
  assert.equal(result.timedOut, false);
});

// Runs the real preamble through a local pwsh. Skipped where pwsh is absent, the same way the
// helper tests skip; it is the only test that observes the preamble's actual runtime behaviour.
const pwshAvailable = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']).status === 0;
test('preamble produces no output and leaves user-visible defaults alone', {skip:!pwshAvailable}, async () => {
  const { PREAMBLE } = await load();
  const { spawnSync } = await import('node:child_process');
  const run = script => spawnSync('pwsh', ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8' });
  // Alone, the preamble must be completely silent: any stray expression would pollute stdout.
  const bare = run(PREAMBLE);
  assert.equal(bare.status, 0, bare.stderr);
  assert.equal(bare.stdout, '', 'the preamble must not write to stdout');
  assert.equal(bare.stderr, '', 'the preamble must not write to stderr');
  // It must not change error semantics, and it must apply the three suppression settings.
  // Cast every preference to [string]: `$enum + "|"` otherwise tries to convert "|" into the
  // enum type and throws InvalidArgument.
  const observed = run(PREAMBLE + '[string]$ErrorActionPreference + "|" + [string]$ProgressPreference + "|" + ' +
    '[string]$PSStyle.OutputRendering + "|" + [Console]::OutputEncoding.WebName + "|" + $env:DSH_OEMCP');
  assert.equal(observed.status, 0, observed.stderr);
  const [eap, progress, rendering, consoleEnc, oem] = observed.stdout.trim().split('|');
  assert.equal(eap, 'Continue', 'the preamble must not change $ErrorActionPreference');
  assert.equal(progress, 'SilentlyContinue');
  assert.equal(rendering, 'PlainText');
  assert.equal(consoleEnc.toLowerCase(), 'utf-8', 'PowerShell output must stay UTF-8 for the transport decoder');
  assert.match(oem ?? '', /^\d+$/, 'OEMCP must be probed and exported as a number');
  // Re-running it must be idempotent and still silent.
  const twice = run(PREAMBLE + PREAMBLE);
  assert.equal(twice.status, 0, twice.stderr);
  assert.equal(twice.stdout + twice.stderr, '', 'the preamble must be idempotent and silent');
});
