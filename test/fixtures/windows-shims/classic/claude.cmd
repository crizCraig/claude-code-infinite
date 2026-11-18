@IF EXIST "%~dp0\node.exe" (
  "%~dp0\node.exe"  "%~dp0\pkg\cli.mjs" %*
) ELSE (
  @SETLOCAL
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\pkg\cli.mjs" %*
)