@echo off
rem Starts Session Desk in the background and opens its window. Run stop.cmd to stop it.
rem The first run installs what it needs (one minute, once).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
if exist "node_modules\@lydell\node-pty" goto run
echo First run: installing what Session Desk needs. This takes about a minute, once.
call npm install --no-audit --no-fund
if errorlevel 1 goto failed
:run
wscript.exe "%~dp0start.vbs"
exit /b 0
:nonode
echo Session Desk needs Node.js 18 or newer. Get it from https://nodejs.org and run start.cmd again.
pause
exit /b 1
:failed
echo Installing failed. See the messages above.
pause
exit /b 1
