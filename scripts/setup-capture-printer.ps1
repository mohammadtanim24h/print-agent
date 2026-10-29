# ADR-10 file-port capture printer for the spooler_raw byte-exact test.
# Run ELEVATED (writes the Local Port registry key under HKLM):
#   powershell -ExecutionPolicy Bypass -File scripts/setup-capture-printer.ps1
# Teardown: Remove-Printer PrintAgentCapture (and delete the port value).
param(
  [string]$PrinterName = 'PrintAgentCapture',
  [string]$CaptureFile = 'C:\print-agent-capture\capture.prn'
)
$ErrorActionPreference = 'Stop'

New-Item -ItemType Directory -Force -Path (Split-Path $CaptureFile) | Out-Null

# Local Port monitor: a port whose NAME is a file path writes RAW job bytes
# to that file verbatim. With DATATYPE "RAW" the driver never processes the
# job, so the (mangling-prone) Generic/Text-Only rendering path is bypassed —
# the port receives exactly what the agent wrote.
$portsKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Print\Monitors\Local Port\Ports'
New-Item -Path $portsKey -Force | Out-Null
New-ItemProperty -Path $portsKey -Name $CaptureFile -PropertyType String -Value '' -Force | Out-Null
Restart-Service Spooler -Force

Add-Printer -Name $PrinterName -DriverName 'Generic / Text Only' -PortName $CaptureFile
Write-Output "Created '$PrinterName' on file port '$CaptureFile'."
Write-Output 'Run: pnpm vitest run tests/spooler-raw-capture.test.ts'
