param([Guid]$FixtureId = [Guid]::Empty)

$ErrorActionPreference = 'Stop'
$user = [Microsoft.Win32.Registry]::CurrentUser
$machine = [Microsoft.Win32.Registry]::LocalMachine
$software = if ($FixtureId -eq [Guid]::Empty) { 'Software' } else { "Software\MoyeIntegrationTests\$FixtureId" }
$applications = "$software\Classes\Applications"
$fileExts = "$software\Microsoft\Windows\CurrentVersion\Explorer\FileExts"
$extensions = @('.md', '.markdown', '.mdown', '.mkd')
$executable = $env:MOYE_WINDOWS_EXECUTABLE
$appName = $env:MOYE_WINDOWS_NAME
$icon = $env:MOYE_WINDOWS_ICON
$canonicalName = [IO.Path]::GetFileName($executable)
[string[]]$legacyExecutables = ConvertFrom-Json -InputObject $env:MOYE_WINDOWS_LEGACY_EXECUTABLES
$script:changed = $false

function Get-Command($hive, [string]$application) {
    $key = $hive.OpenSubKey("$applications\$application\shell\open\command")
    if ($null -eq $key) { return }
    try { return $key.GetValue('') } finally { $key.Dispose() }
}

function Test-Command([string]$command, [string[]]$targets) {
    if ($command -match '^\s*(?:"([^"]+)"|(.+?\.exe))(?=\s|$)') {
        $target = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
        return $targets -contains [Environment]::ExpandEnvironmentVariables($target)
    }
    return $false
}

function Set-String($key, [string]$name, [string]$value) {
    if ($key.GetValue($name) -ceq $value) { return }
    $key.SetValue($name, $value, [Microsoft.Win32.RegistryValueKind]::String)
    $script:changed = $true
}

function Clear-Value($key, [string]$name) {
    if ($key.GetValueNames() -notcontains $name) { return }
    $key.DeleteValue($name)
    $script:changed = $true
}

function Set-Association([string]$baseName, [bool]$alias) {
    $application = $user.CreateSubKey("$applications\$baseName")
    try {
        Set-String $application 'FriendlyAppName' $appName
        if ($alias) { Set-String $application 'NoOpenWith' '' } else { Clear-Value $application 'NoOpenWith' }
        $defaultIcon = $application.CreateSubKey('DefaultIcon')
        try { Set-String $defaultIcon '' ('"{0}",0' -f $icon) } finally { $defaultIcon.Dispose() }
        $command = $application.CreateSubKey('shell\open\command')
        try { Set-String $command '' ('"{0}" "%1"' -f $executable) } finally { $command.Dispose() }
        if (!$alias) {
            $types = $application.CreateSubKey('SupportedTypes')
            try {
                foreach ($extension in $extensions) { Set-String $types $extension '' }
            } finally { $types.Dispose() }
        }
    } finally { $application.Dispose() }
}

function Update-OpenWithList([string]$extension, [string[]]$aliases) {
    $list = $user.OpenSubKey("$fileExts\$extension\OpenWithList", $true)
    if ($null -eq $list) { return }
    try {
        $mru = [string]$list.GetValue('MRUList')
        $entries = $list.GetValueNames() | Where-Object { $_ -match '^[a-z]$' -and $aliases -contains $list.GetValue($_) }
        if (!$entries) { return }
        $ordered = @($mru.ToCharArray() | ForEach-Object { [string]$_ })
        $winner = ($ordered + $entries) | Where-Object { $entries -contains $_ } | Select-Object -First 1
        Set-String $list $winner $canonicalName
        $duplicates = $entries | Where-Object { $_ -ne $winner }
        if ($duplicates) {
            Set-String $list 'MRUList' (-join ($ordered | Where-Object { $duplicates -notcontains $_ }))
            foreach ($duplicate in $duplicates) { Clear-Value $list $duplicate }
        }
    } finally { $list.Dispose() }
}

$targets = @($executable) + $legacyExecutables
$existing = Get-Command $user $canonicalName
$machineCommand = Get-Command $machine $canonicalName
if (($existing -and !(Test-Command $existing $targets)) -or (!$existing -and $machineCommand -and !(Test-Command $machineCommand $targets))) {
    throw 'The executable name is already registered to a different installation.'
}
Set-Association $canonicalName $false

$aliases = @($canonicalName)
foreach ($legacy in $legacyExecutables) {
    $baseName = [IO.Path]::GetFileName($legacy)
    if ($aliases -contains $baseName) { continue }
    $oldCommand = Get-Command $user $baseName
    if ($oldCommand) {
        if (!(Test-Command $oldCommand @($executable, $legacy))) { continue }
        # Existing Windows defaults can still point to the original application key.
        Set-Association $baseName $true
    } elseif ((Get-Command $machine $baseName) -or !(Test-Path -LiteralPath $legacy -PathType Leaf)) {
        continue
    }
    $aliases += $baseName
}
if ($aliases.Count -gt 1) {
    foreach ($extension in $extensions) { Update-OpenWithList $extension $aliases }
}

if ($script:changed -and $FixtureId -eq [Guid]::Empty) {
    Add-Type -Namespace Moye -Name WindowsShell -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("shell32.dll")]
public static extern void SHChangeNotify(uint eventId, uint flags, System.IntPtr item1, System.IntPtr item2);
'@
    [Moye.WindowsShell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
}
