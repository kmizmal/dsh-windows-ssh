# dsh-windows-ssh

Native DSH tools for a session-scoped Windows host reached through OpenSSH. Remote commands run in PowerShell 7 through one shared argv (`pwsh -NoLogo -NoProfile -NonInteractive -EncodedCommand`, UTF-16LE) on both the exec and python channels, with UTF-8 output. Because the flag lives in the transport, callers never add it and cannot lose it. The plugin does not install a Windows agent or modify SSH/frp configuration.

## Tools

- windows_status: inspect the configured host and PowerShell runtime.
- windows_exec: run an approved PowerShell script, optionally as a session-owned background job.
- windows_py: run an approved Python program. The source travels over stdin, so it is never spliced into a command line and never hits the 32767-character limit; stdout/stderr come back verbatim. The interpreter is probed as `py -3.14`, `py -3`, `python`, `python3` (the Microsoft Store aliases exit 9009 with no output and are skipped). If none works, the call fails with `PYTHON_NOT_FOUND`.
- windows_read: read a bounded text file.
- windows_readlines: page large files with offset (1-based line) and column (0-based Unicode scalar position). Continue with nextOffset and nextColumn; provide expectedVersion when consistency matters.
- windows_write: create or explicitly overwrite a remote text file.
- windows_replace: replace literal text using a required version fingerprint; ambiguous matches are rejected unless all and expectedCount are supplied.
- windows_upload: stage a bounded local file remotely and verify SHA-256 before atomic publication.
- windows_download: stream the file out of band, then publish it atomically on the remote side. The response is a one-line record after a 4-byte length header; everything after that header's record is the file, so the payload never enters JSON and the old ~780 KiB ceiling (three quarters of `maxOutputBytes`) is gone. The ceiling is now `maxTransferBytes` (16 MiB by default) and only the resulting path comes back.
- windows_job: list, inspect, or cancel current-session jobs. Cancelling local SSH does not prove the remote process stopped.

Mutating operations and execution require host approval. Tools require a host agent session; calls without one fail closed. Remote paths are passed as base64 JSON data, never interpolated into PowerShell source. `windows_py` shares the `exec` approval class with `windows_exec`: one consent covers both, because both run arbitrary code on the host.

### Remote encoding

Every PowerShell payload is prefixed with a short preamble that makes the channel quiet and UTF-8:

- `[Console]::OutputEncoding` and `$OutputEncoding` are pinned to UTF-8. This is the transport's decode contract — `runPowerShell` reads the SSH stream with a UTF-8 decoder, so PowerShell must emit UTF-8.
- `$ProgressPreference = 'SilentlyContinue'` stops `Invoke-WebRequest` and friends from serialising their progress stream as `#< CLIXML ...>` into stderr.
- `$PSStyle.OutputRendering = 'PlainText'` (guarded by `try`/`catch` for PowerShell 5) strips ANSI escapes from the success stream; error records on stderr stay CLIXML, so merge with `2>&1 | Out-String` when you want plain text.
- The host OEM code page is probed from the registry and exported as `$env:DSH_OEMCP` for scripts that need it. It is **not** used to set the console: pointing the console at GBK makes PowerShell emit GBK bytes that the transport decodes as UTF-8, which silently corrupts every helper response and every path in the JSON contract.
- `$ErrorActionPreference` is left alone, so a non-terminating error keeps its normal meaning.

`windows_py` uses a separate preamble that additionally sets `$env:PYTHONUTF8=1` and `$env:PYTHONIOENCODING=utf-8`, so a Python program's own stdio is UTF-8 on both directions.

See [docs/windows-exec-guide.md](docs/windows-exec-guide.md) for native-tool decoding, quoting hazards, and `Invoke-WebRequest` notes.

### Approval behaviour

Approval is requested by class, once per host session: the first `windows_exec` asks, and later `windows_exec` calls in the same session run without a prompt. `windows_py` belongs to that same `exec` class, since it runs arbitrary code too. `windows_write`, `windows_replace`, `windows_upload`, `windows_download` and `windows_job` with `action: "cancel"` share a separate `mutate` class, so consent for execution does not silently authorise writes, and vice versa. Read-only tools (`windows_status`, `windows_read`, `windows_readlines`, `windows_job` list/get) never ask.

Consent is recorded only when a call actually reaches the tool body, which the host permits only after its own gate passed. Two consequences are deliberate:

- Under an `approval: "never"` policy the plugin stays silent instead of asking. The host resolves every ask to `rejected` in that mode, so asking would turn a working preset into a failure; the preset's explicit opt-out governs.
- Consent is never recorded in that mode, so switching the session back to `ask` prompts again.

Set `approvalMode: "call"` to restore per-call prompting. Consent lives in memory for the plugin instance and is keyed by host session id, so it is dropped when the profile restarts and never crosses sessions. Cancelling an SSH call still does not prove the remote process stopped; that caveat applies to the cancellation audit trail, not to whether a later call is allowed.

## Install

```
dsh plugin --profile web add github:kmizmal/dsh-windows-ssh
```

Then restart the profile so the loader mounts the new bundle entry; the plugin has no runtime hot-reload path.

The host packages `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery` are declared as optional peers because the DSH boot process supplies them. Importing the installed module directly with plain `node` from the profile directory therefore fails to resolve them; that is expected and is not a packaging defect. Use `npm run test:host` for a real activation check instead.

## Configuration

The package is loaded as a DSH plugin through its cordis.patch.yml bundle entry. Set identityFile to the SSH private key and adjust host, user, port, and bounded timeout/size limits. The default endpoint is la2.zmal.top:20022 for user zmal.

- `approvalMode`: `"session"` (default) prompts once per approval class per host session; `"call"` prompts for every call.
- `pythonCandidates`: ordered interpreter probe for `windows_py`, default `["py -3.14","py -3","python","python3"]`. Each entry is a command name with an optional version argument; the first one that prints `Python <version>` wins, so the unusable Microsoft Store aliases are skipped.

## Verification

From this directory:

npm test
npm run test:host

The tests use local fixtures and portable PowerShell where available. They never connect to the Windows endpoint.

Seven cases exercise the real scripting layer and the preamble under `pwsh`, so they `skip` when no `pwsh` is on `PATH`. A host without PowerShell therefore reports `pass 41 / skipped 7` and still exits 0 -- do not read that as full coverage. With `pwsh` available the expected line is `pass 48 / skipped 0`.
