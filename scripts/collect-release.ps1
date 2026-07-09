# ============================================================
# Kite Ground Control — collect + rename build outputs (Windows)
# Renames Tauri's outputs to a unified scheme and drops them in <repo>/release/:
#
#     KiteGC_Windows_x64_<Version>_<Type>.<ext>
#
#   Type = installer  (NSIS -setup.exe)
#        | portable   (kite-gc.exe, zipped with an empty `.portable` marker so the download keeps its
#                      data in a data/ folder next to the executable)
#
# One naming source shared by local builds (`just build` / `just build-windows`) AND the GitHub
# release workflow, so the filenames are identical everywhere. The release/ folder is git-ignored.
# ============================================================
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path "$PSScriptRoot\..").Path
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $root 'src-tauri\target' }
$rel = Join-Path $target 'release'
$bundle = Join-Path $rel 'bundle'
$out = Join-Path $root 'release'

$app = 'KiteGC'; $os = 'Windows'; $arch = 'x64'
function Get-Name($type, $ext) { "${app}_${os}_${arch}_${version}_${type}.${ext}" }

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out | Out-Null

$collected = @()

# NSIS installer.
Get-ChildItem (Join-Path $bundle 'nsis\*-setup.exe') -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object {
    $dest = Get-Name 'installer' 'exe'
    Copy-Item $_.FullName (Join-Path $out $dest) -Force
    $script:collected += $dest
}

# Portable executable -> zip (+ a generated empty `.portable` marker).
$exe = Join-Path $rel 'kite-gc.exe'
if (Test-Path $exe) {
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('kitegc-portable-' + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp | Out-Null
    Copy-Item $exe (Join-Path $tmp 'kite-gc.exe') -Force
    New-Item -ItemType File -Path (Join-Path $tmp '.portable') | Out-Null
    $dest = Get-Name 'portable' 'zip'
    Compress-Archive -Path (Join-Path $tmp 'kite-gc.exe'), (Join-Path $tmp '.portable') -DestinationPath (Join-Path $out $dest) -Force
    Remove-Item $tmp -Recurse -Force
    $script:collected += $dest
}

Write-Host ''
if ($collected.Count -eq 0) {
    Write-Host "[collect-release] No build outputs found under $rel - did the build succeed?" -ForegroundColor Yellow
} else {
    Write-Host "[collect-release] Collected into $out :" -ForegroundColor Green
    $collected | ForEach-Object { Write-Host "  - $_" }
}
