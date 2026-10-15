// badmax <bytes>: Messages request with a valid model but max_tokens -5 (rejected before inference).
import { makeBody, count } from "./bench.mjs";
import fs from "node:fs";
const n = Number(process.argv[2]);
const o = JSON.parse(makeBody(n, n < 1e5 ? "text" : "images"));
o.max_tokens = -5;
const body = Buffer.from(JSON.stringify(o));
const res = await count(body, "/v1/messages");
const row = { badmax: true, bytes: body.length, ...res };
fs.appendFileSync("results.jsonl", JSON.stringify(row) + "\n");
console.log(JSON.stringify(row).slice(0, 300));
