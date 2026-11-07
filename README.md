# dsh-windows-ssh

Native DSH tools for a session-scoped Windows host reached through OpenSSH. Remote commands run in PowerShell 7 with UTF-16LE EncodedCommand, NoLogo, NoProfile, and UTF-8 output. The plugin does not install a Windows agent or modify SSH/frp configuration.

## Tools

- windows_status: inspect the configured host and PowerShell runtime.
- windows_exec: run an approved PowerShell script, optionally as a session-owned background job.
- windows_read: read a bounded text file.
- windows_readlines: page large files with offset (1-based line) and column (0-based Unicode scalar position). Continue with nextOffset and nextColumn; provide expectedVersion when consistency matters.
- windows_write: create or explicitly overwrite a remote text file.
- windows_replace: replace literal text using a required version fingerprint; ambiguous matches are rejected unless all and expectedCount are supplied.
- windows_upload: stage a bounded local file remotely and verify SHA-256 before atomic publication.
- windows_download: verify remote byte count and SHA-256, then publish atomically inside the session workspace through the host sandbox shell executor. Because the bytes travel base64 inside one response, the practical cap is about three quarters of `maxOutputBytes` (roughly 780 KiB with defaults); larger files must be fetched in pieces with `windows_exec` or raised limits.
- windows_job: list, inspect, or cancel current-session jobs. Cancelling local SSH does not prove the remote process stopped.

Mutating operations and execution require host approval. Tools require a host agent session; calls without one fail closed. Remote paths are passed as base64 JSON data, never interpolated into PowerShell source.

### Approval behaviour

Approval is requested by class, once per host session: the first `windows_exec` asks, and later `windows_exec` calls in the same session run without a prompt. `windows_write`, `windows_replace`, `windows_upload`, `windows_download` and `windows_job` with `action: "cancel"` share a separate `mutate` class, so consent for execution does not silently authorise writes, and vice versa. Read-only tools (`windows_status`, `windows_read`, `windows_readlines`, `windows_job` list/get) never ask.

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

## Verification

From this directory:

npm test
npm run test:host

The tests use local fixtures and portable PowerShell where available. They never connect to the Windows endpoint.
