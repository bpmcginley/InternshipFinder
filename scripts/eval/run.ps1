# The Flash-Lite comparison on Windows (scripts/eval/README.md), from the repository root:
#
#   powershell -ExecutionPolicy Bypass -File scripts/eval/run.ps1 -FromClipboard
#
# -FromClipboard saves what ISEval.export() copied to scripts/eval/steps.json first (that file holds
# your profile and is git-ignored). The script then shows what was recorded and roughly what the
# replay costs, asks before spending anything, and asks for the Gemini API key at a hidden prompt, so
# the key is never typed on a command line, saved in history or written to a file. It lives only in
# this process's environment and is removed when the run ends. Added 2026-10-04.
param(
  [string]$Steps = "scripts/eval/steps.json",
  [switch]$FromClipboard,
  [string[]]$Extra = @()
)
$ErrorActionPreference = "Stop"

if ($FromClipboard) {
  $text = Get-Clipboard -Raw
  if (-not $text -or -not $text.TrimStart().StartsWith("{")) { throw "The clipboard doesn't hold the export. Run copy(JSON.stringify(await ISEval.export())) in the extension's service-worker console first." }
  [IO.File]::WriteAllText((Join-Path (Get-Location) $Steps), $text, (New-Object Text.UTF8Encoding $false))
  Write-Host "Saved the recorded steps to $Steps"
}
if (-not (Test-Path $Steps)) { throw "No $Steps yet: record some steps first (scripts/eval/README.md)." }

node scripts/eval/autofill_models.mjs $Steps --dry @Extra
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ((Read-Host "Run the comparison now? (y/n)") -notmatch '^[yY]') { exit 0 }

$secure = Read-Host "Gemini API key (hidden)" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:GEMINI_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  node scripts/eval/autofill_models.mjs $Steps @Extra
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Item Env:GEMINI_API_KEY -ErrorAction SilentlyContinue
}
