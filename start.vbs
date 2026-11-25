' Starts Session Desk in the background (no console window). Use stop.cmd to stop it.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "cmd /c node server.js >> """ & dir & "\data\desk.log"" 2>&1", 0, False
