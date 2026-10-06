param([int]$RootProcessId)
$ErrorActionPreference = 'SilentlyContinue'
while (Get-Process -Id $RootProcessId) {
    $benchProcesses = Get-CimInstance Win32_Process
    $benchIds = [System.Collections.Generic.HashSet[int]]::new()
    [void]$benchIds.Add($RootProcessId)
    do {
        $benchChanged = $false
        foreach ($benchProcess in $benchProcesses) {
            if ($benchIds.Contains([int]$benchProcess.ParentProcessId) -and $benchIds.Add([int]$benchProcess.ProcessId)) { $benchChanged = $true }
        }
    } while ($benchChanged)
    $benchResident = 0L
    $benchPrivate = 0L
    foreach ($benchId in $benchIds) {
        $benchProcess = Get-Process -Id $benchId
        if ($benchProcess) { $benchResident += $benchProcess.WorkingSet64; $benchPrivate += $benchProcess.PrivateMemorySize64 }
    }
    [Console]::WriteLine((@{ timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); residentBytes = $benchResident; privateBytes = $benchPrivate } | ConvertTo-Json -Compress))
    Start-Sleep -Milliseconds 1000
}
