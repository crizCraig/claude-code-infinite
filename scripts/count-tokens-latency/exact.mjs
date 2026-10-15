// exact <path> <bytes> [model]: an images body padded (system text) to exactly <bytes>.
import { makeBody, count } from "./bench.mjs";
import fs from "node:fs";
const [path, n, model] = process.argv.slice(2);
const target = Number(n);
const o = JSON.parse(makeBody(target - 3e6, "images"));
if (model) { o.model = model; o.max_tokens = 1; }
const base = Buffer.byteLength(JSON.stringify(o));
o.system = "x".repeat(target - base + o.system.length);
const body = Buffer.from(JSON.stringify(o));
if (body.length !== target) throw new Error(`size ${body.length}`);
const res = await count(body, path);
const row = { exact: path, bytes: body.length, model: o.model, ...res };
fs.appendFileSync("results.jsonl", JSON.stringify(row) + "\n");
console.log(JSON.stringify(row).slice(0, 260));
