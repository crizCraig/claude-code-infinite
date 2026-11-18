:; "${npm_node_execpath}" dist/postinstall.js || :; exit 0
@rem npm supplies its own absolute Node path. POSIX sh runs the line above, cmd skips the label.
@"%npm_node_execpath%" dist/postinstall.js
@exit /b 0
