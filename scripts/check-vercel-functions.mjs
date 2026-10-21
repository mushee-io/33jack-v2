import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
const root = resolve(import.meta.dirname, "..");
function findFunctions(dir) {
  let items = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      if (!name.startsWith("_")) items.push(...findFunctions(abs));
    } else if (name.endsWith(".js")) items.push(relative(root,abs).split("\\").join("/"));
  }
  return items;
}
const functions = findFunctions(join(root,"api"));
const config = JSON.parse(readFileSync(join(root,"vercel.json"),"utf8"));
const limit = 12;
assert.ok(functions.length <= limit, "Vercel Hobby max 12 functions; found " + functions.length + ": " + functions.join(", "));
for (const entry of Object.keys(config.functions || {})) {
  assert.ok(functions.includes(entry), "Stale Vercel functions config: " + entry);
}
assert.ok(config.rewrites.some(x=>x.source==="/api/v2/:resource" && x.destination==="/api/v2?resource=:resource"), "Missing V2 API compatibility rewrite");
assert.ok(config.rewrites.some(x=>x.source==="/api/payment" && x.destination==="/api/payments?kind=detail"), "Missing payment detail compatibility rewrite");
console.log("Vercel Hobby functions: " + functions.length + "/" + limit + "; routes checked");
