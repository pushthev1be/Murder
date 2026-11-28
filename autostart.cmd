@echo off
rem Start Session Desk when you sign in to Windows. Run it again to turn that off.
rem With this on, signing in brings back the desk window, your layout and the sessions that were running.
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Session Desk.lnk"
set "VBS=%~dp0start.vbs"
set "DIR=%~dp0"
if exist "%LNK%" goto off
powershell -NoProfile -Command "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK); $s.TargetPath = 'wscript.exe'; $s.Arguments = '\"' + $env:VBS + '\"'; $s.WorkingDirectory = $env:DIR; $s.Save()"
if errorlevel 1 goto failed
echo Session Desk will now start when you sign in. Run autostart.cmd again to turn this off.
pause
exit /b 0
:off
del "%LNK%"
echo Session Desk will no longer start when you sign in.
pause
exit /b 0
:failed
echo Could not create the startup shortcut.
pause
exit /b 1
