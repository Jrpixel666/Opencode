#!/usr/bin/env node
// Runs the app in a desktop browser for development: serves the bundled web files and a fake
// OpenAI-compatible model at /mock/v1 that streams replies with token usage.
//
//   npm run preview  →  http://localhost:5173
//   Then Providers → Add → Custom server → http://localhost:5173/mock/v1, model "demo"
//
// In the browser, API keys live only in memory (the Android app keeps them encrypted).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../android/app/src/main/assets/web");
const port = Number(process.env.PORT || 5173);
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

const REPLY = `Here's a quick answer from the **demo model**.

- Replies stream in token by token
- Usage is counted in tokens
- Everything is stored on the phone

\`\`\`js
const left = credit / pricePerToken;
\`\`\``;

function mockChat(req, res) {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const body = JSON.parse(raw || "{}");
    const last = [...(body.messages || [])].reverse().find((m) => m.role === "user");
    const said = typeof last?.content === "string" ? last.content : (last?.content || []).find((p) => p.type === "text")?.text || "";
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    for (const w of "The user asked a question; answering briefly.".split(/(?<= )/)) {
      send({ choices: [{ delta: { reasoning_content: w } }] });
      await new Promise((r) => setTimeout(r, 15));
    }
    const text = `You said: “${said.slice(0, 120)}”\n\n${REPLY}`;
    for (const w of text.split(/(?<=\s)/)) {
      send({ choices: [{ delta: { content: w } }] });
      await new Promise((r) => setTimeout(r, 18));
    }
    const prompt = JSON.stringify(body.messages || []).length >> 2;
    send({ choices: [], usage: { prompt_tokens: prompt + 1200, completion_tokens: text.length >> 2, prompt_tokens_details: { cached_tokens: 1000 } } });
    res.end("data: [DONE]\n\n");
  });
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/mock/v1/chat/completions" && req.method === "POST") return mockChat(req, res);
    const file = path.join(root, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, () => console.log(`preview → http://localhost:${port}  (mock model at /mock/v1)`));
