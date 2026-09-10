param(
  [Parameter(Mandatory = $true)] [string] $DesktopPath,
  [Parameter(Mandatory = $true)] [string] $Version,
  [Parameter(Mandatory = $true)] [string] $ProbeRoot
)

$ErrorActionPreference = 'Stop'

function Read-BoundedText {
  param([Parameter(Mandatory = $true)] [string] $Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
  $value = Get-Content -LiteralPath $Path -Raw
  if ($value.Length -gt 32768) { return $value.Substring($value.Length - 32768) }
  return $value
}

if (-not (Test-Path -LiteralPath $DesktopPath -PathType Leaf)) {
  throw "Packaged Windows desktop executable is missing: $DesktopPath"
}
New-Item -ItemType Directory -Path $ProbeRoot -Force | Out-Null
$probeFile = Join-Path $ProbeRoot 'startup-receipt.json'
$stdoutPath = Join-Path $ProbeRoot 'main.stdout.log'
$stderrPath = Join-Path $ProbeRoot 'main.stderr.log'
$desktop = Start-Process `
  -FilePath $DesktopPath `
  -ArgumentList @('--no-sandbox', "--jarvis-startup-probe=$probeFile") `
  -WorkingDirectory (Split-Path $DesktopPath) `
  -Environment @{ T3CODE_HOME = (Join-Path $ProbeRoot 't3-home'); JARVIS_STARTUP_PROBE_FILE = $probeFile; JARVIS_STARTUP_PROBE_QUIT = '1' } `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -PassThru

try {
  $deadline = (Get-Date).AddSeconds(90)
  $receipt = $null
  do {
    if (Test-Path -LiteralPath $probeFile -PathType Leaf) {
      try { $receipt = Get-Content -LiteralPath $probeFile -Raw | ConvertFrom-Json } catch { }
      if ($null -ne $receipt) { break }
    }
    if ($desktop.HasExited) { throw "Packaged Windows desktop exited before startup receipt (exit $($desktop.ExitCode))." }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)

  if ($null -eq $receipt -or $receipt.schemaVersion -ne 1 -or $receipt.product -ne 'Jarvis' -or $receipt.version -ne $Version -or $receipt.platform -ne 'win32' -or $receipt.phase -ne 'main-window-revealed') {
    throw 'Packaged Windows desktop did not produce a valid main-window-revealed startup receipt.'
  }
  if (-not $desktop.WaitForExit(30000)) {
    throw 'Packaged Windows desktop did not complete its graceful quit within 30 seconds.'
  }
  $desktop.Refresh()
  if ($desktop.ExitCode -ne 0) {
    throw "Packaged Windows desktop graceful quit failed with exit code $($desktop.ExitCode)."
  }
  $output = "$(Read-BoundedText -Path $stdoutPath)`n$(Read-BoundedText -Path $stderrPath)"
  if ($output -match '(?i)object has been destroyed') {
    throw 'Packaged Windows desktop reported a destroyed-window main-process failure.'
  }
  if ($output -match '(?i)\buncaught\b|\bunhandled rejection\b') {
    throw 'Packaged Windows desktop reported an uncaught main-process failure.'
  }
  Write-Host "[setup-ci] Packaged Windows desktop startup and graceful quit passed (PID $($desktop.Id))."
} finally {
  if (-not $desktop.HasExited) {
    Write-Host "[setup-ci] Stopping only captured packaged Windows desktop PID $($desktop.Id)."
    Stop-Process -Id $desktop.Id -Force -ErrorAction SilentlyContinue
  }
  $desktop.WaitForExit(30000)
  $output = "$(Read-BoundedText -Path $stdoutPath)`n$(Read-BoundedText -Path $stderrPath)"
  if (-not [string]::IsNullOrWhiteSpace($output)) {
    Write-Host '[setup-ci] Bounded packaged Windows desktop main-process output (last 32768 chars):'
    Write-Host $output
  }
  Remove-Item -LiteralPath $ProbeRoot -Recurse -Force -ErrorAction SilentlyContinue
}
