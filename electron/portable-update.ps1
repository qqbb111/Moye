$ErrorActionPreference = 'Stop'
$exe = [IO.Path]::GetFullPath($env:MOYE_UPDATE_EXE)
$root = [IO.Path]::GetDirectoryName($exe)
$stage = [IO.Path]::GetFullPath($env:MOYE_UPDATE_STAGE)
if ([IO.Path]::GetDirectoryName($stage) -ne $root -or [IO.Path]::GetFileName($stage) -notmatch '^\.moye-update-[a-zA-Z0-9]+$') { throw 'Invalid update directory' }
if (([IO.File]::GetAttributes($stage) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked update directory' }
$payload = Join-Path $stage 'payload'
$rootFiles = @('Moye.exe', 'moye.ico', 'version', 'LICENSE', 'LICENSES.chromium.html', 'THIRD_PARTY_NOTICES.txt', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'icudtl.dat', 'libEGL.dll', 'libGLESv2.dll', 'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll')
function Assert-Unlinked($file) {
  $item = Get-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Linked application file or folder' }
}
function Test-UpdateFile($name) {
  return ($name -cin $rootFiles -or $name -ceq 'resources/app.asar' -or $name -cmatch '^locales/[a-zA-Z0-9-]+\.pak$')
}
function Get-Digest($file) {
  $stream = [IO.File]::OpenRead($file)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [Convert]::ToBase64String($sha.ComputeHash($stream)) }
  finally { $sha.Dispose(); $stream.Dispose() }
}

if ($env:MOYE_UPDATE_MODE -eq 'extract') {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead((Join-Path $stage 'download.zip'))
  $files = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  try {
    $bytes = 0L
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName -creplace '^\./', ''
      if ($name -cin @('', 'locales/', 'resources/')) { continue }
      if (!(Test-UpdateFile $name) -or !$files.Add($name)) { throw 'Invalid or duplicate release ZIP entry' }
      $bytes += $entry.Length
      if ($files.Count -gt 300 -or $bytes -gt 650MB) { throw 'Release ZIP is too large' }
    }
    foreach ($required in @('Moye.exe', 'moye.ico', 'version', 'resources.pak', 'icudtl.dat', 'resources/app.asar', 'locales/en-US.pak')) {
      if (!$files.Contains($required)) { throw 'Incomplete release ZIP' }
    }
    [void][IO.Directory]::CreateDirectory($payload)
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName -creplace '^\./', ''
      if (!(Test-UpdateFile $name)) { continue }
      $file = Join-Path $payload $name
      [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file))
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $file, $false)
    }
  } finally { $zip.Dispose() }
  exit 0
}

if ($env:MOYE_UPDATE_MODE -ne 'apply') { throw 'Invalid update action' }
$job = $env:MOYE_UPDATE_JOB
if ($job -notmatch '^[a-f0-9-]{36}$') { throw 'Invalid update job' }
$confirmation = Join-Path $stage "helper-go-$job"
[IO.File]::WriteAllText((Join-Path $stage "helper-ready-$job"), 'ready')
for ($attempt = 0; $attempt -lt 120 -and ![IO.File]::Exists($confirmation); $attempt++) { Start-Sleep -Milliseconds 100 }
if (![IO.File]::Exists($confirmation)) { exit 1 }
$backups = Join-Path $stage 'backup'
$plan = @()
$result = 'failed'
$canClean = $true
try {
  $appProcess = Get-Process -Id ([int]$env:MOYE_UPDATE_PID) -ErrorAction SilentlyContinue
  if ($appProcess) { Wait-Process -InputObject $appProcess -Timeout 45 }
  Assert-Unlinked $payload
  foreach ($directory in @('locales', 'resources')) {
    Assert-Unlinked (Join-Path $payload $directory)
    Assert-Unlinked (Join-Path $root $directory)
  }
  $files = Get-ChildItem -LiteralPath $payload -File -Recurse -Force | Sort-Object { if ($_.Name -eq 'Moye.exe') { 1 } else { 0 } }
  foreach ($file in $files) {
    Assert-Unlinked $file.FullName
    $name = $file.FullName.Substring($payload.Length + 1).Replace('\', '/')
    if (!(Test-UpdateFile $name)) { throw 'Unexpected staged file' }
    $target = if ($name -eq 'Moye.exe') { $exe } else { Join-Path $root $name }
    Assert-Unlinked $target
    if ([IO.Directory]::Exists($target)) { throw 'An application path is occupied by a directory' }
    if ([IO.File]::Exists($target) -and $file.Length -eq (Get-Item -LiteralPath $target).Length -and (Get-Digest $file.FullName) -ceq (Get-Digest $target)) { continue }
    $backup = Join-Path $backups $name
    $plan += @{ Source = $file.FullName; Target = $target; Backup = $backup; Added = $false }
  }
  foreach ($entry in $plan) {
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($entry.Target))
    if ([IO.File]::Exists($entry.Target)) {
      [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($entry.Backup))
      for ($attempt = 0; $attempt -lt 20; $attempt++) {
        try { [IO.File]::Replace($entry.Source, $entry.Target, $entry.Backup, $true); break }
        catch {
          if ($attempt -eq 19 -or [IO.File]::Exists($entry.Backup)) { throw }
          Start-Sleep -Milliseconds 150
        }
      }
    } else {
      [IO.File]::Move($entry.Source, $entry.Target)
      $entry.Added = $true
    }
  }
  $result = 'installed'
} catch {
  try { [IO.File]::WriteAllText(($env:MOYE_UPDATE_RESULT + '.log'), ($_ | Out-String)) } catch {}
  for ($i = $plan.Count - 1; $i -ge 0; $i--) {
    $entry = $plan[$i]
    try {
      if ([IO.File]::Exists($entry.Backup)) { [IO.File]::Copy($entry.Backup, $entry.Target, $true) }
      elseif ($entry.Added) { [IO.File]::Delete($entry.Target) }
    } catch { $canClean = $false; $result = 'recovery-required' }
  }
}

try { [IO.File]::WriteAllText($env:MOYE_UPDATE_RESULT, $result) } catch {}
if ($canClean) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
if ($result -ne 'recovery-required' -and !(Get-Process -Id ([int]$env:MOYE_UPDATE_PID) -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath $exe -WorkingDirectory $root
}
