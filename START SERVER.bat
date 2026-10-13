@echo off
title Whist server
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed.
  echo  Download the LTS version from https://nodejs.org , install it, then run this file again.
  echo.
  pause
  exit /b
)
rem First run: open the firewall (Windows asks for permission - click Yes).
netsh advfirewall firewall show rule name="Whist server" >nul 2>nul
if errorlevel 1 (
  echo  First start: opening the Windows firewall for the game. Click "Yes" on the Windows prompt.
  powershell -NoProfile -Command "Start-Process -FilePath '%~dp0FIX FIREWALL.bat' -Verb RunAs -Wait"
)
node server.js 8080
pause
