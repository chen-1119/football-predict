Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
rootDir = fso.GetParentFolderName(scriptDir)
psScript = fso.BuildPath(scriptDir, "runCloudSync.ps1")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & psScript & """"
shell.CurrentDirectory = rootDir
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
