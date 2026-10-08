# Registers the site as a Windows scheduled task that starts the supervisor
# (scripts\supervisor.js) without a console window.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#       start when the current user logs on (no administrator rights needed)
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -AtStartup
#       start when the computer boots, before anyone logs on (run as administrator)
#
# The supervisor restarts the server after a crash; the task settings restart
# the supervisor itself if it ever exits.
param(
  [switch]$AtStartup,
  [string]$TaskName = "ZhanaraSite"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }
if (-not (Test-Path $node)) { throw "node.exe не найден. Установите Node.js 24+." }
if (-not (Test-Path (Join-Path $root "dist\index.html"))) {
  throw "Сайт не собран. Выполните npm run build и запустите скрипт снова."
}

# Without --headless node.exe gets a visible console window; closing it kills
# the supervisor and the server at once, and the task is not restarted.
$conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
$action = New-ScheduledTaskAction -Execute $conhost -Argument "--headless `"$node`" `"$root\scripts\supervisor.js`"" -WorkingDirectory $root
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable -MultipleInstances IgnoreNew

if ($AtStartup) {
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
} else {
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Задача $TaskName зарегистрирована и запущена. Журнал: $root\data\logs"
