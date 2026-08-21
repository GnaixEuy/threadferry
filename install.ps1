#Requires -Version 5.1

[CmdletBinding()]
param(
  [switch] $NoOnboard,
  [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ReleasePackageUrl = "https://github.com/GnaixEuy/threadferry/releases/latest/download/threadferry.tgz"

function Format-Argument {
  param([string] $Value)

  if ($Value -match '^[A-Za-z0-9_./:@+\\-]+$') { return $Value }
  return "'" + $Value.Replace("'", "''") + "'"
}

function Write-Command {
  param(
    [string] $Command,
    [string[]] $Arguments
  )

  $parts = @((Format-Argument $Command)) + @($Arguments | ForEach-Object { Format-Argument $_ })
  Write-Host ("  " + ($parts -join " "))
}

function Resolve-NativeCommand {
  param([string] $Name)

  foreach ($candidate in @("$Name.cmd", "$Name.exe", $Name)) {
    $resolved = Get-Command $candidate -CommandType Application, ExternalScript -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($null -ne $resolved) { return $resolved.Source }
  }
  return $null
}

function Invoke-Captured {
  param(
    [string] $Command,
    [string[]] $Arguments
  )

  $output = & $Command @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: $(Format-Argument $Command) $($Arguments -join ' ')`n$($output -join "`n")"
  }
  return (($output | ForEach-Object { "$_" }) -join "`n").Trim()
}

function Invoke-Mutation {
  param(
    [string] $Command,
    [string[]] $Arguments
  )

  if ($DryRun) {
    Write-Command $Command $Arguments
    return
  }

  & $Command @Arguments | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: $(Format-Argument $Command) $($Arguments -join ' ')"
  }
}

function Test-PathEntry {
  param(
    [AllowNull()][string] $PathValue,
    [string] $Entry
  )

  if ([string]::IsNullOrWhiteSpace($PathValue)) { return $false }
  $normalized = $Entry.TrimEnd('\')
  return @($PathValue -split ';' | Where-Object { $_.Trim().TrimEnd('\') -eq $normalized }).Count -gt 0
}

function Ensure-NpmPrefixOnPath {
  param([string] $Prefix)

  if (-not (Test-PathEntry $env:Path $Prefix)) {
    $env:Path = "$Prefix;$env:Path"
  }

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  if ((Test-PathEntry $userPath $Prefix) -or (Test-PathEntry $machinePath $Prefix)) { return }

  if ($DryRun) {
    Write-Host "  Add '$Prefix' to the current user's PATH"
    return
  }

  $nextUserPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $Prefix } else { "$userPath;$Prefix" }
  try {
    [Environment]::SetEnvironmentVariable("Path", $nextUserPath, "User")
    Write-Host "Added npm's global directory to the current user's PATH: $Prefix"
  } catch {
    Write-Warning "Could not persist npm's global directory in PATH. Add it manually: $Prefix"
  }
}

function Get-SemanticVersion {
  param([string] $Text)

  $match = [regex]::Match($Text, '\d+\.\d+\.\d+')
  if (-not $match.Success) { return $null }
  try { return ([version] $match.Value) } catch { return $null }
}

function Get-WecomAuthorization {
  param([string] $WecomCli)

  $output = & $WecomCli auth show --status 2>$null
  return $LASTEXITCODE -eq 0 -and (($output | ForEach-Object { "$_" }) -join "`n").Trim() -eq "authorized"
}

function Ensure-WecomCli {
  param([string] $Npm)

  $wecomCli = Resolve-NativeCommand "wecom-cli"
  $installed = if ($null -ne $wecomCli) { Invoke-Captured $wecomCli @("--version") } else { "" }
  $version = Get-SemanticVersion $installed
  if ($null -ne $version -and $version -ge [version] "1.1.0") {
    Write-Host "Found $installed."
    return $wecomCli
  }

  if ($installed) {
    Write-Host "Updating official wecom-cli to 1.1.0+; current version is $installed."
  } else {
    Write-Host "Installing official wecom-cli 1.1.0+..."
  }
  Invoke-Mutation $Npm @("install", "--global", "@wecom/cli")
  if ($DryRun) { return $null }

  $wecomCli = Resolve-NativeCommand "wecom-cli"
  if ($null -eq $wecomCli) {
    throw "wecom-cli was installed, but its npm global directory is not in PATH."
  }
  $installed = Invoke-Captured $wecomCli @("--version")
  $version = Get-SemanticVersion $installed
  if ($null -eq $version -or $version -lt [version] "1.1.0") {
    throw "wecom-cli 1.1.0+ is required; installed version is $installed."
  }
  return $wecomCli
}

function Test-InteractiveTerminal {
  try { return [Environment]::UserInteractive -and -not [Console]::IsInputRedirected }
  catch { return [Environment]::UserInteractive }
}

function Install-ThreadFerry {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "This installer supports Windows. On macOS or Linux, use install.sh."
  }

  $node = Resolve-NativeCommand "node"
  if ($null -eq $node) {
    throw "Node.js 22+ is required: https://nodejs.org/en/download"
  }
  $nodeMajorText = Invoke-Captured $node @("-p", "Number(process.versions.node.split('.')[0])")
  $nodeMajor = 0
  if (-not [int]::TryParse($nodeMajorText, [ref] $nodeMajor) -or $nodeMajor -lt 22) {
    $nodeVersion = Invoke-Captured $node @("--version")
    throw "Node.js 22+ is required; current version is $nodeVersion."
  }

  $npm = Resolve-NativeCommand "npm"
  if ($null -eq $npm) {
    throw "npm was not found in PATH. Reinstall Node.js 22+ with npm."
  }
  $npmPrefixOutput = Invoke-Captured $npm @("prefix", "--global")
  $npmPrefix = @($npmPrefixOutput -split "`r?`n" | Where-Object { $_.Trim() })[-1].Trim()
  if (-not [IO.Path]::IsPathRooted($npmPrefix)) {
    throw "npm returned an invalid global prefix: $npmPrefix"
  }
  Ensure-NpmPrefixOnPath $npmPrefix

  $wecomCli = Ensure-WecomCli $npm

  Write-Host "Installing ThreadFerry..."
  Invoke-Mutation $npm @("install", "--global", "--ignore-scripts", $ReleasePackageUrl)
  if ($DryRun) {
    Write-Host "Dry run complete. Next: threadferry onboard"
    return
  }

  $threadferry = Resolve-NativeCommand "threadferry"
  if ($null -eq $threadferry) {
    throw "ThreadFerry was installed, but its npm global directory is not in PATH: $npmPrefix"
  }
  $installedVersion = Invoke-Captured $threadferry @("--version")
  Write-Host "Installed ThreadFerry $installedVersion."

  $authorized = Get-WecomAuthorization $wecomCli
  if ($NoOnboard) {
    if ($authorized) {
      Write-Host "wecom-cli is already configured. Next: threadferry onboard; it will ask whether to reuse the saved credentials."
    } else {
      Write-Host "Next: wecom-cli auth init, then threadferry onboard"
    }
    return
  }

  if (-not (Test-InteractiveTerminal)) {
    Write-Host "No interactive terminal detected. Next: wecom-cli auth init, then threadferry onboard"
    return
  }

  if (-not $authorized) {
    Write-Host "Initializing official wecom-cli (scan QR code or enter Bot ID and Secret)..."
    Invoke-Mutation $wecomCli @("auth", "init")
    if (-not (Get-WecomAuthorization $wecomCli)) {
      throw "wecom-cli initialization did not produce a valid authorization. Retry with: wecom-cli auth init"
    }
  }

  Write-Host "wecom-cli is configured. ThreadFerry will ask whether to reuse its saved credentials."
  Invoke-Mutation $threadferry @("onboard")
}

try {
  Install-ThreadFerry
} catch {
  throw "ThreadFerry installer: $($_.Exception.Message)"
}
