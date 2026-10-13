@echo off
title Whist - allow port 8080
net session >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Please right-click this file and choose "Run as administrator".
  echo.
  pause
  exit /b
)
netsh advfirewall firewall delete rule name="Whist server" >nul 2>nul
netsh advfirewall firewall add rule name="Whist server" dir=in action=allow protocol=TCP localport=8080 profile=any
echo.
echo  Done. Phones on your Wi-Fi can now reach the Whist server on port 8080.
echo.
pause
