# Registers the Grab helper (native messaging host) for Chrome and Edge, current user only.
# Run:  powershell -ExecutionPolicy Bypass -File native-host\install.ps1
$ErrorActionPreference = 'Stop'
$hostName = 'com.grab.ytdlp'
$here = $PSScriptRoot
$root = Split-Path $here -Parent

# Extension ID is derived from the "key" in manifest.json (sha256 -> first 32 hex chars mapped 0-f => a-p)
$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
$der = [Convert]::FromBase64String($manifest.key)
$hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($der)
$hex = -join ($hash[0..15] | ForEach-Object { $_.ToString('x2') })
$extId = -join ($hex.ToCharArray() | ForEach-Object { [char](97 + [Convert]::ToInt32([string]$_, 16)) })

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js was not found. Install it with: winget install OpenJS.NodeJS.LTS' }

# Launcher Chrome starts. Must not print anything except the protocol.
$bat = Join-Path $here 'host.bat'
"@echo off`r`n`"$node`" `"%~dp0host.js`" %*`r`n" | Set-Content -Path $bat -Encoding ascii -NoNewline

$hostManifest = Join-Path $here "$hostName.json"
[ordered]@{
  name            = $hostName
  description     = 'Grab helper: runs yt-dlp for the Grab extension'
  path            = $bat
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$extId/")
} | ConvertTo-Json | Set-Content -Path $hostManifest -Encoding utf8

foreach ($browser in 'Google\Chrome', 'Microsoft\Edge') {
  $key = "HKCU:\Software\$browser\NativeMessagingHosts\$hostName"
  New-Item -Path $key -Force | Out-Null
  Set-Item -Path $key -Value $hostManifest
}

Write-Host "Grab helper installed."
Write-Host "  Extension ID : $extId"
Write-Host "  Node         : $node"
Write-Host "  Host manifest: $hostManifest"
