param([switch]$NoDialog)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $projectRoot ".workbench.pid"

function Show-Message([string]$message, [string]$icon) {
    if ($NoDialog) {
        Write-Output $message
        return
    }
    Add-Type -AssemblyName PresentationFramework
    $messageIcon = if ($icon -eq "Error") {
        [System.Windows.MessageBoxImage]::Error
    }
    else {
        [System.Windows.MessageBoxImage]::Information
    }
    [System.Windows.MessageBox]::Show(
        $message,
        "ClassRuler Workbench",
        [System.Windows.MessageBoxButton]::OK,
        $messageIcon
    ) | Out-Null
}

if (-not (Test-Path -LiteralPath $pidFile)) {
    Show-Message "No one-click-started workbench process was found." "Information"
    exit 0
}

try {
    $identity = Get-Content -LiteralPath $pidFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $process = Get-Process -Id ([int]$identity.pid) -ErrorAction SilentlyContinue
    if ($process) {
        $actualStartedAt = $process.StartTime.ToUniversalTime()
        if ($identity.started_unix_ms) {
            $expectedStartedAt = [DateTimeOffset]::FromUnixTimeMilliseconds(
                [long]$identity.started_unix_ms
            ).UtcDateTime
            $startDifference = [Math]::Abs(
                ($actualStartedAt - $expectedStartedAt).TotalSeconds
            )
            $identityMatches = $startDifference -le 5
        }
        else {
            $identityMatches = $actualStartedAt.Ticks -eq [long]$identity.started_at
        }
        if (-not $identityMatches) {
            throw "The saved process ID now belongs to another program."
        }
        Stop-Process -Id $process.Id
        [void]$process.WaitForExit(10000)
    }
    Remove-Item -LiteralPath $pidFile -Force
    Show-Message "The workbench has been stopped safely." "Information"
}
catch {
    Show-Message ("The workbench could not be stopped: " + $_.Exception.Message) "Error"
    exit 1
}
