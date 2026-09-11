$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot
$studioUrl = 'http://127.0.0.1:4317'
$studioRunning = $false
try { $health = Invoke-RestMethod -Uri "$studioUrl/health" -TimeoutSec 2; $studioRunning = $health.app -eq 'voice-prep-studio' } catch {}
if (-not $studioRunning) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw 'Node.js 18 or newer is required. Install Node.js and run this file again.' }
    Start-Process -FilePath $nodeCommand.Source -ArgumentList ('"' + (Join-Path $projectDirectory 'server.mjs') + '"') -WorkingDirectory $projectDirectory -WindowStyle Hidden
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 200
        try { $health = Invoke-RestMethod -Uri "$studioUrl/health" -TimeoutSec 1; if ($health.app -eq 'voice-prep-studio') { $studioRunning = $true; break } } catch {}
    }
    if (-not $studioRunning) { throw 'Could not start Voice Prep Studio. Check port 4317.' }
}
Start-Process $studioUrl
