@echo off
setlocal
cd /d "%~dp0"

curl.exe -s --max-time 2 "http://127.0.0.1:8765/api/status" >nul 2>nul
if errorlevel 1 (
  start "SW Industry Trend Server" /min "%~dp0start.bat"
  timeout /t 3 /nobreak >nul
)

start "" "http://127.0.0.1:8765/"
endlocal
