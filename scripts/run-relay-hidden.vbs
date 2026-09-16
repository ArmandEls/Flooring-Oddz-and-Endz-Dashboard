' Launches the relay script fully detached: no console window, and not
' attached to any parent console's process group, so it can't be killed by
' a Ctrl+C signal broadcast to some other unrelated console session.
Set objShell = CreateObject("WScript.Shell")
objShell.Run "cmd /c ""C:\Program Files\nodejs\node.exe"" ""C:\Users\Operations\team-dashboard\scripts\push-losses.js"" >> ""C:\Users\Operations\team-dashboard\relay.log"" 2>&1", 0, False
