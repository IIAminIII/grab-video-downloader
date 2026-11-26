# Removes the Grab helper registration.
$hostName = 'com.grab.ytdlp'
foreach ($browser in 'Google\Chrome', 'Microsoft\Edge') {
  Remove-Item -Path "HKCU:\Software\$browser\NativeMessagingHosts\$hostName" -Force -ErrorAction SilentlyContinue
}
Remove-Item -Path (Join-Path $PSScriptRoot "$hostName.json"), (Join-Path $PSScriptRoot 'host.bat') -ErrorAction SilentlyContinue
Write-Host 'Grab helper removed.'
