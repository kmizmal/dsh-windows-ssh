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

## Install

```
dsh plugin --profile web add github:kmizmal/dsh-windows-ssh
```

Then restart the profile so the loader mounts the new bundle entry; the plugin has no runtime hot-reload path.

The host packages `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery` are declared as optional peers because the DSH boot process supplies them. Importing the installed module directly with plain `node` from the profile directory therefore fails to resolve them; that is expected and is not a packaging defect. Use `npm run test:host` for a real activation check instead.

## Configuration

The package is loaded as a DSH plugin through its cordis.patch.yml bundle entry. Set identityFile to the SSH private key and adjust host, user, port, and bounded timeout/size limits. The default endpoint is la2.zmal.top:20022 for user zmal.

## Verification

From this directory:

npm test
npm run test:host

The tests use local fixtures and portable PowerShell where available. They never connect to the Windows endpoint.
