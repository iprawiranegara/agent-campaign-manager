[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string] $Source,

    [Parameter(Mandatory = $false)]
    [string] $Sha256
)

$ErrorActionPreference = 'Stop'

if ($Sha256 -and $Sha256 -notmatch '^[0-9a-fA-F]{64}$') {
    throw 'SHA-256 must be exactly 64 hexadecimal characters.'
}

$temporaryDirectory = $null
$packagePath = $null
try {
    if ($Source -match '^https://') {
        $uri = [Uri] $Source
        if ($uri.UserInfo -or $uri.Query -or $uri.Fragment) {
            throw 'HTTPS URLs with embedded credentials, query strings, or fragments are not accepted.'
        }
        if (-not $Sha256) {
            throw 'Remote HTTPS archives require -Sha256 with the published 64-character SHA-256 digest.'
        }
        $temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ('campaign-manager-install-' + [Guid]::NewGuid().ToString('N'))
        [void] [IO.Directory]::CreateDirectory($temporaryDirectory)
        $packagePath = Join-Path $temporaryDirectory 'package.tgz'
        Invoke-WebRequest -UseBasicParsing -Uri $uri -OutFile $packagePath
    }
    elseif ($Source -match '^http://') {
        throw 'Remote archives must use HTTPS.'
    }
    else {
        $packagePath = (Resolve-Path -LiteralPath $Source).Path
        if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
            throw 'Local package archive must be a file.'
        }
    }

    if ($Sha256) {
        $actual = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash
        if ($actual -ine $Sha256) {
            throw 'SHA-256 digest mismatch; npm was not invoked.'
        }
    }

    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $npm) {
        throw 'npm is required. Install Node.js 24 or later, then retry.'
    }
    if ($env:LOCALAPPDATA) {
        $dataHome = $env:LOCALAPPDATA
    }
    else {
        $dataHome = Join-Path $HOME 'AppData/Local'
    }
    if (-not [IO.Path]::IsPathRooted($dataHome)) {
        throw 'LOCALAPPDATA must be an absolute path when set.'
    }
    $installPrefix = Join-Path $dataHome 'omo-research/npm'
    [void] [IO.Directory]::CreateDirectory($installPrefix)
    & $npm.Source install --global --prefix $installPrefix --ignore-scripts $packagePath
    if ($LASTEXITCODE -ne 0) {
        throw "npm install failed with exit code $LASTEXITCODE."
    }
    Write-Output 'Installed campaign-manager without elevation.'
    Write-Output (Join-Path $installPrefix 'campaign-manager.cmd')
}
finally {
    if ($temporaryDirectory -and (Test-Path -LiteralPath $temporaryDirectory)) {
        Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
    }
}
