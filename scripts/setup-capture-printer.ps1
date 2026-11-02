# ADR-10 file-port capture printer for the spooler_raw byte-exact test.
# Run ELEVATED (writes the Local Port registry key under HKLM):
#   powershell -ExecutionPolicy Bypass -File scripts/setup-capture-printer.ps1
# Teardown: Remove-Printer PrintAgentCapture (and delete the port value).
param(
  [string]$PrinterName = 'PrintAgentCapture',
  [string]$CaptureFile = 'C:\print-agent-capture\capture.prn',
  # TCP-capture mode: -CaptureHost/-CapturePort create a Standard TCP/IP port
  # instead of the Local-Port file trick. The spooler then delivers RAW bytes
  # to a listener on that address — the 2026-11-02 Win10 19045 physical smoke
  # used this mode because the registry file-port was not enumerated by the
  # spooler on that box even after a restart.
  [string]$CaptureHost = '',
  [int]$CapturePort = 9100
)
$ErrorActionPreference = 'Stop'

# The 'Generic / Text Only' driver ships in the inbox INF prnge001.inf but is
# NOT staged in the driver store on a stock Win10 19045 box (Add-Printer fails
# 0x80070705 without this — observed 2026-11-02).
pnputil /add-driver "$env:windir\INF\prnge001.inf" /install | Out-Null
Add-PrinterDriver -Name 'Generic / Text Only' -ErrorAction SilentlyContinue

if ($CaptureHost -ne '') {
  $portName = "CAPTURE_$CapturePort"
  if (-not (Get-PrinterPort -Name $portName -ErrorAction SilentlyContinue)) {
    Add-PrinterPort -Name $portName -PrinterHostAddress $CaptureHost -PortNumber $CapturePort
  }
  if (Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue) {
    Remove-Printer -Name $PrinterName
  }
  Add-Printer -Name $PrinterName -DriverName 'Generic / Text Only' -PortName $portName
  Write-Output "Created '$PrinterName' on TCP port ${CaptureHost}:${CapturePort} (run a capture listener there)."
  Write-Output 'Run: pnpm vitest run tests/spooler-raw-capture.test.ts  # file-mode only'
  return
}

New-Item -ItemType Directory -Force -Path (Split-Path $CaptureFile) | Out-Null

# Local Port monitor: a port whose NAME is a file path writes RAW job bytes
# to that file verbatim. With DATATYPE "RAW" the driver never processes the
# job, so the (mangling-prone) Generic/Text-Only rendering path is bypassed —
# the port receives exactly what the agent wrote.
$portsKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Print\Monitors\Local Port\Ports'
# Create-only-if-missing: New-Item -Force on an EXISTING key recreates it and
# wipes all values (including the system's COM1:/LPT1:/FILE: port definitions).
if (-not (Test-Path $portsKey)) {
  New-Item -Path $portsKey | Out-Null
}
# -Force here only overwrites THIS one value, not the key.
New-ItemProperty -Path $portsKey -Name $CaptureFile -PropertyType String -Value '' -Force | Out-Null
Restart-Service Spooler -Force

if (Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue) {
  Write-Output "'$PrinterName' already exists - removing and recreating it."
  Remove-Printer -Name $PrinterName
}
Add-Printer -Name $PrinterName -DriverName 'Generic / Text Only' -PortName $CaptureFile
Write-Output "Created '$PrinterName' on file port '$CaptureFile'."
Write-Output 'Run: pnpm vitest run tests/spooler-raw-capture.test.ts'
