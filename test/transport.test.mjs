import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEventListeners } from 'node:events';

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
  assert.match(decoded, /\[Console\]::OutputEncoding\s*=/);
  assert.match(decoded, /\$OutputEncoding\s*=/);
  assert.match(decoded, /UTF8Encoding/);
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
