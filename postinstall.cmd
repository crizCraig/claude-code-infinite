@rem npm/pnpm/Yarn on Windows cmd.exe supply their own absolute Node path (no bare `node` lookup in cwd).
@if not defined npm_node_execpath exit /b 0
@"%npm_node_execpath%" dist/postinstall.js
@exit /b 0
