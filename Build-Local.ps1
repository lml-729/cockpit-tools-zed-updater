param(
    [string]$SourceDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent) 'cockpit-tools'),
    [string]$Repository = 'lml-729/cockpit-tools-zed-updater',
    [string]$PublicKey = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEM3QTI4QTQ5QzkyMDM4OEYKUldTUE9DREpTWXFpeCtPMWZ4elFRU0dOcE9CWnpBaXJXTVN6TVdleTdiVHFnQkc1OTg4SzJieGcK'
)
$ErrorActionPreference = 'Stop'
function Run-Checked([string]$Command, [string[]]$CommandArgs) {
    & $Command @CommandArgs
    if ($LASTEXITCODE -ne 0) { throw "$Command failed (exit $LASTEXITCODE)" }
}
foreach ($tool in @('git', 'node', 'npm', 'cargo', 'go')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Missing $tool" }
}
$SourceDirectory = [System.IO.Path]::GetFullPath($SourceDirectory)
if (-not (Test-Path -LiteralPath $SourceDirectory)) {
    Run-Checked 'git' @('clone', '--branch', 'v1.3.64', 'https://github.com/jlcodes99/cockpit-tools.git', $SourceDirectory)
}
$sourceCommit = (& git -C $SourceDirectory rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceCommit -ne '4434c32e7bb02f33246941eb5179b0252a93481a') {
    throw 'Expected official v1.3.64 commit 4434c32e7bb02f33246941eb5179b0252a93481a. Use a separate checkout for another version.'
}
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
$env:CARGO_BUILD_JOBS = '4'
Push-Location $SourceDirectory
try {
    if (-not (Test-Path 'node_modules/typescript')) { Run-Checked 'npm' @('ci') }
    $probeTarget = Join-Path $SourceDirectory 'src-tauri/src/modules/zed_student_hosted_ai.rs'
    $probeTemplate = Join-Path $PSScriptRoot 'scripts/zed-student-hosted-ai.rs'
    if (-not (Test-Path -LiteralPath $probeTarget)) {
        $dirty = & git status --porcelain
        if ($dirty) { throw 'Source checkout has existing changes. Use a clean separate checkout before applying patches.' }
        $env:TAURI_SIGNING_PUBLIC_KEY = $PublicKey
        Run-Checked 'node' @((Join-Path $PSScriptRoot 'scripts/customize.cjs'), $SourceDirectory, $Repository)
        Run-Checked 'node' @((Join-Path $PSScriptRoot 'scripts/zed-student-availability.cjs'), $SourceDirectory)
    } elseif ((Get-FileHash -LiteralPath $probeTarget).Hash -ne (Get-FileHash -LiteralPath $probeTemplate).Hash) {
        throw 'Patched source differs from the current probe template. Prepare a fresh separate checkout; this script will not overwrite edits.'
    }
    Run-Checked 'node' @((Join-Path $PSScriptRoot 'scripts/zed-student-availability.test.cjs'), $SourceDirectory)
    Run-Checked 'cargo' @('test', '--manifest-path', (Join-Path $PSScriptRoot 'scripts/probe-harness/Cargo.toml'), 'zed_hosted_ai_tests')
    $logDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) 'build-logs'
    New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
    $configPath = Join-Path $logDirectory 'tauri.local-build.json'
    [System.IO.File]::WriteAllText($configPath, '{"bundle":{"createUpdaterArtifacts":false,"targets":["nsis"]}}', [System.Text.UTF8Encoding]::new($false))
    Run-Checked 'npm' @('run', 'tauri', '--', 'build', '--config', $configPath, '--no-sign', '--ci')
    Write-Host "EXE: $(Join-Path $SourceDirectory 'target/release/cockpit-tools.exe')"
    Write-Host "Installer: $(Join-Path $SourceDirectory 'target/release/bundle/nsis')"
} finally {
    Pop-Location
}
