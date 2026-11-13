param(
  [switch]$Live,
  [ValidateRange(1, 3)][int]$Reps = 2,
  [string]$Case
)
$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'hydrogen_compare.mjs'
$arguments = @($runner, "--reps=$Reps")
if ($Case) { $arguments += "--case=$Case" }

if (-not $Live) {
  & node @arguments
  exit $LASTEXITCODE
}

$existing = [Environment]::GetEnvironmentVariable('INTERNSCOUT_GEMINI_EVAL_KEY', 'Process')
$bstr = [IntPtr]::Zero
try {
  if (-not $existing) {
    $secure = Read-Host 'Gemini test project API key (hidden)' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $env:INTERNSCOUT_GEMINI_EVAL_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  }
  & node @arguments --live
  exit $LASTEXITCODE
} finally {
  if ($bstr -ne [IntPtr]::Zero) {
    Remove-Item Env:INTERNSCOUT_GEMINI_EVAL_KEY -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    $secure.Dispose()
  }
}
