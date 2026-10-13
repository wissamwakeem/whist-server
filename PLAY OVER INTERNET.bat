@echo off
title Whist - internet link
where cloudflared >nul 2>nul
if errorlevel 1 (
  echo.
  echo  This needs Cloudflare's free tunnel tool (no account needed).
  echo  Install it once by running this command in a terminal:
  echo.
  echo      winget install --id Cloudflare.cloudflared
  echo.
  echo  Then close this window and run this file again.
  echo.
  pause
  exit /b
)
echo.
echo  Keep "START SERVER.bat" running too.
echo  Below, look for a line with  https://SOMETHING.trycloudflare.com
echo  Every player types that link in the app (gear icon). It changes each time you run this.
echo.
cloudflared tunnel --url http://localhost:8080
pause
