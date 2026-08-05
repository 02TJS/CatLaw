$ErrorActionPreference = "Stop"

$workspace = Split-Path -Parent $PSScriptRoot
$toolboxRoot = "D:\Codex_Sandbox\Codex_Resume"
$runtimeDirectory = Join-Path $workspace "release\win-unpacked-0.14.13"
$runtimeCandidates = @(Get-ChildItem -LiteralPath $runtimeDirectory -Filter "*.exe" -File)
if ($runtimeCandidates.Count -ne 1) {
  throw "expected exactly one runtime exe in $runtimeDirectory, found $($runtimeCandidates.Count)"
}
$runtime = $runtimeCandidates[0].FullName
$resultPath = Join-Path $workspace "output\toolbox-detached-launch\result.json"
$resultDirectory = Split-Path -Parent $resultPath
New-Item -ItemType Directory -Path $resultDirectory -Force | Out-Null

$before = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $runtime -and $_.CommandLine -notmatch "--type=" } | Select-Object -ExpandProperty ProcessId)
$launcherCode = "from codex_toolbox.cat_workshop import launch_cat_workshop; launch_cat_workshop()"
$launcher = Start-Process -FilePath "python.exe" -ArgumentList @(
  "-c",
  ('"' + $launcherCode + '"')
) -WorkingDirectory $toolboxRoot -PassThru -WindowStyle Hidden
$launcher.WaitForExit()
if ($launcher.ExitCode -ne 0) { throw "simulated Toolbox launcher exited with $($launcher.ExitCode)" }

$process = $null
for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
  $process = Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -eq $runtime -and $_.CommandLine -notmatch "--type=" -and $_.ProcessId -notin $before
  } | Select-Object -First 1
  if ($process) { break }
  Start-Sleep -Milliseconds 250
}
if (-not $process) { throw "detached Cat Workshop process did not start" }

Start-Sleep -Milliseconds 750
$stillRunning = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.ProcessId)" -ErrorAction SilentlyContinue
if (-not $stillRunning) { throw "Cat Workshop exited with the simulated Toolbox parent" }

$result = [ordered]@{
  launcherPid = $launcher.Id
  launcherExited = $launcher.HasExited
  catWorkshopPid = $process.ProcessId
  catWorkshopSurvivedParentExit = $true
  executablePath = $process.ExecutablePath
}
$result | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding utf8

Stop-Process -Id $process.ProcessId -Force
$result | ConvertTo-Json
