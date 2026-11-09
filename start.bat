@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PYTHON_VERSION=3.12.10"
set "PYTHON_ARCH=amd64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "PYTHON_ARCH=arm64"

call :check_python
if not errorlevel 1 goto run_server

echo Python 3.9+ was not found. Preparing the environment...
where winget >nul 2>nul
if errorlevel 1 goto download_python

echo Trying winget...
winget install --id Python.Python.3.12 --exact --scope user --accept-package-agreements --accept-source-agreements
call :check_python
if not errorlevel 1 goto run_server

:download_python
echo winget was unavailable or failed. Downloading Python from python.org...
set "PYTHON_INSTALLER=%TEMP%\python-%PYTHON_VERSION%-%PYTHON_ARCH%.exe"
set "PYTHON_URL=https://www.python.org/ftp/python/%PYTHON_VERSION%/python-%PYTHON_VERSION%-%PYTHON_ARCH%.exe"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '%PYTHON_URL%' -OutFile '%PYTHON_INSTALLER%'"
if errorlevel 1 goto failed

echo Installing Python for the current user...
start "" /wait "%PYTHON_INSTALLER%" /quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1 Include_test=0 Shortcuts=1
call :check_python
if errorlevel 1 goto failed

:run_server
echo.
echo Python:
%PYTHON_CMD% --version
echo Starting http://127.0.0.1:8765/
%PYTHON_CMD% server.py
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo Python environment setup or server startup failed.
echo You can still open industry-dashboard.html to use the offline version.
echo For manual installation visit: https://www.python.org/downloads/windows/
pause
exit /b 1

:check_python
where py >nul 2>nul
if not errorlevel 1 (
  py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul
  if not errorlevel 1 (
    set "PYTHON_CMD=py -3"
    exit /b 0
  )
)

where python >nul 2>nul
if not errorlevel 1 (
  python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul
  if not errorlevel 1 (
    set "PYTHON_CMD=python"
    exit /b 0
  )
)

if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" (
  "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul
  if not errorlevel 1 (
    set "PYTHON_CMD="%LOCALAPPDATA%\Programs\Python\Python312\python.exe""
    exit /b 0
  )
)
exit /b 1
