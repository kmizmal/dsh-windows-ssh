# windows_exec / windows_py guide

Practical notes for driving a Windows host through this plugin. Everything below was measured
on a real CP936 (Simplified Chinese) Windows host over OpenSSH, not inferred.

## What the preamble already does for you

Every payload is prefixed with a short preamble. You do not need to repeat any of it:

| Setting | Value | Why |
| --- | --- | --- |
| `[Console]::OutputEncoding` | UTF-8 | The transport decodes the SSH stream as UTF-8, so PowerShell must emit UTF-8. |
| `$OutputEncoding` | UTF-8 | Encoding used when piping text **into** a native process. |
| `[Console]::InputEncoding` | UTF-8 | Large scripts arrive on stdin as UTF-8. |
| `$ProgressPreference` | `SilentlyContinue` | Kills CLIXML progress dumps on stderr. |
| `$PSStyle.OutputRendering` | `PlainText` | Strips ANSI escapes from the success stream (guarded for PS 5). |
| `$env:DSH_OEMCP` | host OEM code page | Exported for scripts that must decode native GBK output. |
| `$ErrorActionPreference` | **unchanged** | Deliberately not touched: it would silently change script semantics. |

So this first line, common in older snippets, is redundant:

```powershell
[Console]::OutputEncoding = [Text.Encoding]::UTF8   # already done by the preamble
```

## Pitfall 1 — CLIXML noise on stderr

PowerShell serialises the error and progress streams to XML when stderr is redirected (which it
always is over SSH):

```
#< CLIXML
<Objs Version="1.1.0.1" ...><S S="Error">_x001B_[31;1mWrite-Error: ...</S></Objs>
```

`$ProgressPreference='SilentlyContinue'` removes **progress** records entirely (verified: a
`Write-Progress` loop produces `stderr_len=0`, `hasCLIXML=false`).

Error records still go through CLIXML on stderr, because that stream is serialised before any
rendering preference applies. To get plain error text, merge into the success stream:

```powershell
Write-Error 'boom' 2>&1 | Out-String     # => "Write-Error: boom"
```

`$PSStyle.OutputRendering='PlainText'` then strips the ANSI colour codes:

```powershell
$PSStyle.OutputRendering = 'PlainText'; $PSStyle.Foreground.Red + 'RED' + $PSStyle.Reset
# => "RED"                     (Host mode would keep \u001b[31m ... \u001b[0m)
```

For control flow, prefer `try`/`catch` with `-ErrorAction Stop` and report through the success
stream; that keeps stdout JSON-clean and stderr empty:

```powershell
try { Get-Item 'C:\missing' -ErrorAction Stop }
catch { "caught: $($_.Exception.Message)" }
```

## Pitfall 2 — native tools and the OEM code page

This is the subtle one, and it is why the preamble pins the console to UTF-8 rather than to the
OEM code page.

PowerShell strings and native children need **opposite** console settings:

```
[Console]::OutputEncoding = UTF8  -> "中文" emits e4 b8 ad ...   (correct for the transport)
                                     ipconfig Chinese becomes "IPv4 Address." (native tool bytes
                                     are GBK and get mis-decoded)
[Console]::OutputEncoding = 936   -> "中文" emits d6 d0 ce c4 ... (GBK; the UTF-8 transport
                                     turns it into mojibake)
                                     ipconfig Chinese is correct
```

`chcp 65001` does **not** fix the native side. `Console::OutputEncoding` and `chcp` are
independent knobs — setting the former to UTF-8 still leaves `chcp` reporting `936`, and a native
tool's source page follows the system OEM page regardless.

Because the plugin's JSON contract depends on UTF-8, the console stays UTF-8. When you need to
read a native GBK tool, switch the decoder **only around that call** and always restore it:

```powershell
$o = [Console]::OutputEncoding
[Console]::OutputEncoding = [Text.Encoding]::GetEncoding([int]$env:DSH_OEMCP)
$t = & ipconfig | Out-String
[Console]::OutputEncoding = $o          # MUST restore: later PS output is GBK otherwise
($t -split "`r?`n" | Where-Object { $_ -match 'IPv4' } | Select-Object -First 1).Trim()
```

Measured result: `IPv4 地址 . . . . . . . . . . . . : 10.11.217.43`, and the JSON built afterwards
is still lossless UTF-8.

> If you blank `$env:DSH_OEMCP`, `[int]$env:DSH_OEMCP` throws. Guard with
> `if (-not $env:DSH_OEMCP) { $env:DSH_OEMCP = '65001' }`.

Restoring matters: forget the last line and every later PowerShell string in the same script is
emitted as GBK, which the transport decodes as UTF-8 mojibake. Keep the window around the native
call only.

## Pitfall 3 — `$_` and `$()` inside double quotes

PowerShell expands `$_` and `$()` inside **double**-quoted strings. In a `Where-Object` filter this
usually bites as "the property is not the one I meant":

```powershell
# Broken: "$_.Name" expands $_ at string-build time, outside the pipeline
Get-ChildItem | Where-Object { "$_.Name" -like '*.txt' }

# Correct: let the pipeline bind $_
Get-ChildItem | Where-Object { $_.Name -like '*.txt' }

# Correct, when you need a string: subexpression
Get-ChildItem | ForEach-Object { "file: $($_.Name)" }
```

The same trap applies over SSH in one extra way: text you send is not re-parsed by a local shell,
so quoting is stable, but `"..."` inside the script is still expanded by **PowerShell**. When you
want a literal dollar sign, use single quotes or backtick it:

```powershell
'$notExpanded'
"`$notExpanded"
```

Prefer single quotes for regex patterns and paths; interpolate explicitly.

## Pitfall 4 — `Invoke-WebRequest`

Three things to know:

1. **Use `-UseBasicParsing` on PowerShell 5.1** — otherwise it needs the IE engine and fails on
   Server Core. PowerShell 7 ignores the flag but accepts it.
2. **gzip/deflate is not decompressed by default.** Request it and set the decompression:

   ```powershell
   $r = Invoke-WebRequest -Uri $u -UseBasicParsing -Headers @{ 'Accept-Encoding' = 'gzip, deflate' }
   if ($r.Headers['Content-Encoding'] -match 'gzip') {
     $ms = [IO.MemoryStream]::new($r.RawContentStream.ToArray())
     $gz = [IO.Compression.GZipStream]::new($ms, [IO.Compression.CompressionMode]::Decompress)
     $text = [IO.StreamReader]::new($gz, [Text.Encoding]::UTF8).ReadToEnd()
   }
   ```

   Or sidestep it entirely with `-OutFile`, which writes the raw body and lets you decompress once:

   ```powershell
   Invoke-WebRequest -Uri $u -OutFile $tmp -UseBasicParsing
   ```

3. **Progress was the old CLIXML source.** `$ProgressPreference='SilentlyContinue'` is already
   applied by the preamble, so you no longer need to set it per script.

For JSON APIs, `Invoke-RestMethod` returns a parsed object and avoids the encoding question:

```powershell
Invoke-RestMethod -Uri $u -UseBasicParsing | ConvertTo-Json -Depth 5 -Compress
```

## Python channel: `windows_py`

`windows_py` runs a Python program whose **source travels over stdin**. It is never spliced into a
command line: no quoting problems, no `$` interpolation, and no 32767-character command limit.

```js
// tool call
{ script: 'import sys\nprint("中文", sys.version.split()[0])' }
```

The interpreter is probed in this order: `py -3.14`, `py -3`, `python`, `python3`. The Microsoft
Store aliases (`python.exe` in `WindowsApps`) are 0-byte placeholders that exit `9009` with no
output, so the probe requires real `Python <version>` text and skips them. If none qualifies the
call fails with code `PYTHON_NOT_FOUND`.

The python channel pins both directions to UTF-8 (`PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`,
console in/out UTF-8), so `print("中文")` and even non-BMP emoji survive. A GBK-mode python would
abort with `UnicodeEncodeError: 'gbk' codec can't encode character '\U0001f600'`.

Differences from `windows_exec`:

- Output is the program's own stdout/stderr, returned verbatim. It is **not** parsed as a JSON
  envelope, so print whatever you like.
- `cwd` is rejected. The program owns its directory; call `os.chdir(...)` (and set
  `PYTHONPATH`/`sys.path` yourself if you add the script's location).
- `sys.argv` is `['-']`, because the interpreter reads the program from stdin rather than a file.

### Exit codes are not reliable for failure reason

Windows OpenSSH runs the remote shell as pwsh, and **any nested pwsh collapses every nonzero exit
to 1**:

```
ssh exit 42                                  -> 42
pwsh -EncodedCommand "exit 42"               -> 1
pwsh -EncodedCommand "& py -3.14 ... exit 4" -> 1
pwsh -EncodedCommand "exit 0"                -> 0
```

So `exit 1` and `exit 99` are indistinguishable, and the same applies to `windows_exec`: a user
script that ends with `exit 42` reports `exitCode: 1`. This is a host-environment limitation, not
a plugin defect. Zero is trustworthy; nonzero means "failed", not "failed this particular way".

Consequence: **express failure reasons in stdout/stderr, not in exit codes.**

```python
import json, sys
try:
    result = {"ok": True, "value": compute()}
except Exception as e:
    result = {"ok": False, "error": type(e).__name__, "message": str(e)}
print(json.dumps(result, ensure_ascii=False))
sys.exit(0 if result["ok"] else 1)
```

Parse stdout and branch on `ok`, never on the numeric code.

## Choosing a channel

| Need | Use |
| --- | --- |
| Windows APIs, registry, services, WMI/CIM | `windows_exec` |
| Text processing, JSON, HTTP with a real library | `windows_py` |
| Calling a native Windows tool with Chinese output | `windows_exec` + the scoped-decode idiom |
| Anything long (> ~8000 chars) | either; both use stdin for large payloads |

`windows_py` shares the `exec` approval class with `windows_exec`: one consent covers both,
because both run arbitrary code.
