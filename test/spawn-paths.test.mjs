// Inspect call expressions (including multiline calls and imported aliases), not comments.
// Variable commands must pass the executable-path check at the spawn boundary too.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { executablePath } from "../dist/executable-path.js";
import { RUNNER_SOURCE } from "../dist/auto-update-runner.js";

test("src process launches use checked executables and explicit shell paths", () => {
  const violations = [];
  function scan(file, code) {
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
    const calls = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "spawnImpl", "spawnFn"]);
    const shells = new Set(["exec", "execSync"]);
    const modules = new Set(['require("node:child_process")', 'require("child_process")']);
    for (const item of source.statements) {
      if (!ts.isImportDeclaration(item)) continue;
      const name = item.moduleSpecifier.text;
      const clause = item.importClause;
      if (!clause) continue;
      if (name === "cross-spawn") violations.push(file + ": implicit shell and shebang resolution");
      if (!["node:child_process", "child_process"].includes(name)) continue;
      if (clause.name) modules.add(clause.name.text);
      const bindings = clause.namedBindings;
      if (!bindings) continue;
      if (ts.isNamespaceImport(bindings)) modules.add(bindings.name.text);
      else for (const spec of bindings.elements) {
        const imported = (spec.propertyName ?? spec.name).text;
        (shells.has(imported) ? shells : calls).add(spec.name.text);
      }
    }
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const expr = node.expression;
        const call = expr.getText(source);
        const member = ts.isPropertyAccessExpression(expr) ? expr.name.text : call;
        const owner = ts.isPropertyAccessExpression(expr) ? expr.expression.getText(source) : "";
        if (shells.has(member) && (!owner || modules.has(owner) || member === "execSync")) {
          violations.push(file + ": implicit shell via " + call);
        }
        if (calls.has(member)) {
          const arg = node.arguments[0];
          const checked = arg && ts.isCallExpression(arg) &&
            ["executablePath", "system32Path"].includes(arg.expression.getText(source));
          if (!checked && arg?.getText(source) !== "process.execPath") {
            violations.push(file + ": " + call + "(" + arg?.getText(source) + ")");
          }
        }
      }
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === "shell" && node.initializer.getText(source) !== "false") {
        violations.push(file + ": implicit shell launch");
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  const src = new URL("../src/", import.meta.url);
  for (const file of fs.readdirSync(src, { recursive: true }).filter(f => path.extname(f) === ".ts")) {
    scan(file, fs.readFileSync(new URL(file, src), "utf8"));
  }
  scan("dist/key-input.js", fs.readFileSync(new URL("../dist/key-input.js", import.meta.url), "utf8"));
  scan("detached updater", RUNNER_SOURCE);
  assert.deepEqual(violations, []);
});

test("the Windows spawn boundary rejects paths that depend on the working directory", () => {
  for (const file of ["ps", "git.exe", ".\\claude.cmd", "C:tools\\git.exe", "\\tools\\git.exe", "/bin/ps"]) {
    assert.throws(() => executablePath(file, "win32"), /absolute executable path/);
  }
  for (const file of ["C:\\tools\\git.exe", "\\\\server\\share\\bin\\claude.exe"]) {
    assert.equal(executablePath(file, "win32"), file);
  }
});
