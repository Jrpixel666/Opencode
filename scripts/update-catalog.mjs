#!/usr/bin/env node
// Builds the model catalog bundled in the app (android/app/src/main/assets/web/catalog.json)
// from models.dev, the open model database opencode uses. The app also refreshes it on the
// phone, so this snapshot is only the offline starting point.
//
//   node scripts/update-catalog.mjs [path/to/api.json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { slimCatalog } from "../android/app/src/main/assets/web/js/catalog.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "android/app/src/main/assets/web/catalog.json");

const src = process.argv[2];
const raw = src ? JSON.parse(fs.readFileSync(src, "utf8")) : await (await fetch("https://models.dev/api.json")).json();
const slim = slimCatalog(raw);
fs.writeFileSync(out, JSON.stringify(slim));
const models = slim.providers.reduce((n, p) => n + p.models.length, 0);
console.log(`${slim.providers.length} providers, ${models} models → ${path.relative(root, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
