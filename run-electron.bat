@echo off
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if exist "%~dp0node_modules\electron\dist\electron.exe" (
  start "" /b "%~dp0node_modules\electron\dist\electron.exe" "%~dp0main.js" %*
) else (
  npx --yes electron@28.3.3 . %*
)
