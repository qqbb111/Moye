import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const fixture = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$fixtureId = [Guid]::NewGuid()
$root = "Software\MoyeIntegrationTests\$fixtureId"
$user = [Microsoft.Win32.Registry]::CurrentUser
$apps = "$root\Classes\Applications"
$list = "$root\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\OpenWithList"
$choice = "$root\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoiceLatest\ProgId"
$oldCommand = "$apps\Typora Replica.exe\shell\open\command"
$unrelatedCommand = "$apps\Rypota.exe\shell\open\command"

function Write-Value($path, $name, $value) {
  $key = $user.CreateSubKey($path)
  try { $key.SetValue($name, $value) } finally { $key.Dispose() }
}
function Read-Value($path, $name) {
  $key = $user.OpenSubKey($path)
  if ($key) { try { $key.GetValue($name) } finally { $key.Dispose() } }
}
try {
  Write-Value $oldCommand '' '"C:\Moye fixture\Typora Replica.exe" "%1"'
  Write-Value $unrelatedCommand '' '"C:\Unrelated\Rypota.exe" "%1"'
  Write-Value $choice 'ProgId' 'Applications\Typora Replica.exe'
  Write-Value $list 'a' 'Typora.exe'
  Write-Value $list 'h' 'Rypota.exe'
  Write-Value $list 'i' 'Typora Replica.exe'
  Write-Value $list 'j' 'Moye.exe'
  Write-Value $list 'MRUList' 'iahj'
  $migration = [ScriptBlock]::Create([IO.File]::ReadAllText($env:MOYE_WINDOWS_SCRIPT_FIXTURE))
  & $migration -FixtureId $fixtureId
  & $migration -FixtureId $fixtureId
  @{
    name = Read-Value "$apps\Moye.exe" 'FriendlyAppName'
    oldName = Read-Value "$apps\Typora Replica.exe" 'FriendlyAppName'
    hiddenAlias = Read-Value "$apps\Typora Replica.exe" 'NoOpenWith'
    supported = Read-Value "$apps\Moye.exe\SupportedTypes" '.md'
    legacyCommand = Read-Value $oldCommand ''
    unrelatedCommand = Read-Value $unrelatedCommand ''
    choice = Read-Value $choice 'ProgId'
    mru = Read-Value $list 'MRUList'
    replacement = Read-Value $list 'i'
    duplicate = Read-Value $list 'j'
    nativeTypora = Read-Value $list 'a'
    unrelated = Read-Value $list 'h'
  } | ConvertTo-Json -Compress
} finally { $user.DeleteSubKeyTree($root, $false) }
`;

test('迁移 Windows 打开方式时保留默认选择及其他应用', { skip: process.platform !== 'win32' }, async () => {
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(fixture, 'utf16le').toString('base64')], {
    windowsHide: true,
    timeout: 15000,
    env: {
      ...process.env,
      MOYE_WINDOWS_SCRIPT_FIXTURE: path.resolve('electron/windows-associations.ps1'),
      MOYE_WINDOWS_NAME: '墨页 Moye',
      MOYE_WINDOWS_EXECUTABLE: 'C:\\Moye fixture\\Moye.exe',
      MOYE_WINDOWS_ICON: 'C:\\Moye fixture\\moye.ico',
      MOYE_WINDOWS_LEGACY_EXECUTABLES: JSON.stringify(['C:\\Moye fixture\\Typora Replica.exe', 'C:\\Moye fixture\\Rypota.exe']),
    },
  });
  assert.deepEqual(JSON.parse(stdout), {
    name: '墨页 Moye', oldName: '墨页 Moye', hiddenAlias: '', supported: '',
    legacyCommand: '"C:\\Moye fixture\\Moye.exe" "%1"', unrelatedCommand: '"C:\\Unrelated\\Rypota.exe" "%1"',
    choice: 'Applications\\Typora Replica.exe', mru: 'iah', replacement: 'Moye.exe', duplicate: null,
    nativeTypora: 'Typora.exe', unrelated: 'Rypota.exe',
  });
});
