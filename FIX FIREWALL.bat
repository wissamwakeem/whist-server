@echo off
title Whist - fix firewall
rem Asks for administrator rights by itself (click "Yes" on the Windows prompt).
net session >nul 2>nul
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo.
echo  Opening the firewall for the Whist server...
echo.
rem 1. Allow the game port (TCP 8080) on every network type (Home, Public, Work).
netsh advfirewall firewall delete rule name="Whist server" >nul 2>nul
netsh advfirewall firewall add rule name="Whist server" dir=in action=allow protocol=TCP localport=8080 profile=any >nul
rem 2. If "Cancel" was clicked on the Windows popup for Node.js, Windows added a BLOCK rule
rem    for node.exe. Block rules win over allow rules, so remove them.
powershell -NoProfile -Command "Get-NetFirewallApplicationFilter | Where-Object { $_.Program -like '*node.exe' } | Get-NetFirewallRule | Where-Object { $_.Action -eq 'Block' -and $_.Direction -eq 'Inbound' } | Remove-NetFirewallRule" >nul 2>nul
rem 3. Allow node.exe itself as well.
netsh advfirewall firewall delete rule name="Whist server (node)" >nul 2>nul
for /f "delims=" %%i in ('where node 2^>nul') do netsh advfirewall firewall add rule name="Whist server (node)" dir=in action=allow program="%%i" profile=any >nul
echo  Done. Phones on your Wi-Fi can now reach the Whist server.
echo.
timeout /t 4 >nul
