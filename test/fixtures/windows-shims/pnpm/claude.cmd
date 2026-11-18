@SETLOCAL
@IF NOT DEFINED NODE_PATH (
  @SET "NODE_PATH=C:\global\node_modules;C:\store\node_modules"
) ELSE (
  @SET "NODE_PATH=C:\global\node_modules;C:\store\node_modules;%NODE_PATH%"
)
@IF EXIST "%~dp0\node.exe" (
  "%~dp0\node.exe"  "%~dp0\pkg\cli.mjs" %*
) ELSE (
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\pkg\cli.mjs" %*
)
