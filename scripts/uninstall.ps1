param(
  [ValidateSet('auto','codex','claude','both')][string]$Target = 'auto',
  [ValidateSet('user','project')][string]$Scope = 'user',
  [string]$Project, [string]$Bundle, [string]$Checksum, [string]$Version,
  [switch]$DryRun, [switch]$Yes, [switch]$KeepData
)
$ErrorActionPreference = 'Stop'
$cliArgs = @('uninstall', '--target', $Target, '--scope', $Scope)
foreach ($pair in @(@('--project',$Project), @('--bundle',$Bundle), @('--checksum',$Checksum), @('--version',$Version))) {
  if ($pair[1]) { $cliArgs += $pair }
}
if ($DryRun) { $cliArgs += '--dry-run' }
if ($Yes) { $cliArgs += '--yes' }
if ($KeepData) { $cliArgs += '--keep-data' }
& node (Join-Path $PSScriptRoot '../packages/installer/src/manage.ts') @cliArgs
exit $LASTEXITCODE
