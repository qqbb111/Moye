@echo off
setlocal
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
if exist "%~dp0release\Moye-win32-x64\Moye.exe" (
  start "" "%~dp0release\Moye-win32-x64\Moye.exe" %*
) else if exist "%~dp0node_modules\electron\dist\electron.exe" (
  start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0" %*
) else (
  echo Please run npm ci and npm run build first.
  pause
)
