# Packs the plugin folder into a .streamDeckPlugin file (a zip archive) in dist/.
# Usage: powershell -ExecutionPolicy Bypass -File build.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$name = 'com.github.nbraun1.sonarswitch'
$src = Join-Path $PSScriptRoot "$name.sdPlugin"
$dist = Join-Path $PSScriptRoot 'dist'
$out = Join-Path $dist "$name.streamDeckPlugin"

New-Item -ItemType Directory -Force $dist | Out-Null
if (Test-Path $out) { Remove-Item $out -Force }

# Entries need forward slashes, which Compress-Archive in Windows PowerShell 5.1 does not guarantee.
$zip = [IO.Compression.ZipFile]::Open($out, 'Create')
try {
    Get-ChildItem -Recurse -File $src |
        Where-Object { $_.FullName -notlike (Join-Path $src 'logs\*') } |
        ForEach-Object {
            $rel = "$name.sdPlugin/" + $_.FullName.Substring($src.Length + 1).Replace('\', '/')
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel)
        }
} finally {
    $zip.Dispose()
}

Write-Host "Created $out"
