@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js first.
  pause
  exit /b 1
)

if not exist "node_modules\express" (
  echo [ERROR] Dependencies not found.
  echo Run: npm install
  pause
  exit /b 1
)

call npm start
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Server stopped with exit code %EXIT_CODE%.
  pause
)

endlocal & exit /b %EXIT_CODE%
