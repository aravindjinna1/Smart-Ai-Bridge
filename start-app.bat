@echo off
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
echo ========================================
echo   Starting AI Bridge Desktop App...
echo ========================================
echo.

:: Start server in a separate process
echo [1/2] Starting server (server.js)...
start "AI Bridge Server" cmd /c "cd /d "%~dp0" && node server.js"
echo Server starting on http://localhost:3000

:: Brief wait for server startup
timeout /t 3 /nobreak >nul

:: Start Electron desktop window
echo [2/2] Starting Electron desktop window...
if exist "%~dp0node_modules\electron\dist\electron.exe" (
  start "Electron" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0main.js"
) else (
  start "Electron" cmd /c "cd /d "%~dp0" && npx --yes electron@28.3.3 ."
)

echo.
echo App is starting! The desktop window should appear shortly.
echo Close this window to stop logging.
pause
