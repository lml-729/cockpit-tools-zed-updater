param([string]$Repository = 'lml-729/cockpit-tools-zed-updater')
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Run-Checked([string]$Command, [string[]]$CommandArgs) {
    & $Command @CommandArgs
    if ($LASTEXITCODE -ne 0) { throw "$Command failed (exit $LASTEXITCODE)" }
}

if ($Repository -notmatch '^[a-zA-Z0-9-]+/[a-zA-Z0-9_.-]+$') { throw 'Invalid repository name' }
foreach ($tool in @('git', 'gh', 'node', 'npm', 'npx')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "Missing $tool. Install Git, GitHub CLI and Node.js from their official sources, then run again."
    }
}

# This is a one-time setup. No GitHub password or token is requested in chat.
& gh auth status --hostname github.com *> $null
if ($LASTEXITCODE -ne 0) {
    Run-Checked 'gh' @('auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https', '--scopes', 'workflow')
}
$login = (& gh api user --jq '.login').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not identify GitHub account' }
if ($Repository.Split('/')[0] -ne $login) { throw "This setup is for $Repository, but GitHub CLI is signed in as $login" }

& gh repo view $Repository *> $null
if ($LASTEXITCODE -eq 0) { throw "Repository $Repository already exists. Setup refuses to overwrite it." }
if (Test-Path '.git') { throw 'This folder already has Git history. Use a fresh extracted setup folder.' }

# The signing key stays locally and in the new repository's encrypted Actions Secret.
# Never include .keys in a commit or upload it as a release asset.
New-Item -ItemType Directory -Force '.keys' | Out-Null
$keyPath = Join-Path $PSScriptRoot '.keys/updater.key'
$passwordPath = Join-Path $PSScriptRoot '.keys/updater-password.txt'
if (-not (Test-Path $keyPath)) {
    $generateLog = Join-Path $PSScriptRoot '.keys/generate.log'
    $keyPassword = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
    [System.IO.File]::WriteAllText($passwordPath, $keyPassword, [System.Text.UTF8Encoding]::new($false))
    & npx --yes '@tauri-apps/cli@2' signer generate --ci --password $keyPassword --write-keys $keyPath *> $generateLog
    if ($LASTEXITCODE -ne 0) { throw 'Signing key generation failed; see the private .keys/generate.log file.' }
}
if (-not (Test-Path "$keyPath.pub")) { throw 'Public key missing; do not replace an existing private key.' }
if (-not (Test-Path $passwordPath)) { throw 'Signing key password backup is missing; setup will not rotate a key.' }
$publicKey = (Get-Content "$keyPath.pub" -Raw).Trim()

Run-Checked 'gh' @('repo', 'create', $Repository, '--public', '--description', 'Personal Windows builds of Cockpit Tools with stable Zed ordering and signed in-app updates')
Get-Content $keyPath -Raw | & gh secret set TAURI_SIGNING_PRIVATE_KEY --repo $Repository
if ($LASTEXITCODE -ne 0) { throw 'Could not save Actions signing secret. No source was pushed.' }
$savedPassword = (Get-Content $passwordPath -Raw).Trim()
Run-Checked 'gh' @('secret', 'set', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD', '--repo', $Repository, '--body', $savedPassword)
Run-Checked 'gh' @('variable', 'set', 'TAURI_SIGNING_PUBLIC_KEY', '--repo', $Repository, '--body', $publicKey)
Run-Checked 'gh' @('auth', 'setup-git')
Run-Checked 'git' @('init', '-b', 'main')
Run-Checked 'git' @('add', '.github', 'scripts', '.gitignore', 'README.md')
Run-Checked 'git' @('-c', "user.name=$login", '-c', "user.email=$login@users.noreply.github.com", 'commit', '-m', 'Build official releases with stable Zed ordering and personal signed updates')
Run-Checked 'git' @('remote', 'add', 'origin', "https://github.com/$Repository.git")
Run-Checked 'git' @('push', '-u', 'origin', 'main')

Write-Host ''
Write-Host "Setup submitted: https://github.com/$Repository/actions"
Write-Host "After the first build succeeds, install its x64-setup.exe once."
Write-Host 'Later updates use the client update button / automatic-update setting.'
Write-Host 'Back up .keys/updater.key privately. This setup has not verified a running Windows client.'
