// Demo mode (OCB_DEMO=1): a tiny in-memory stand-in for `opencode serve`, so the app can be
// tried without opencode installed. It implements just the routes the app uses.
import http from "node:http";

const now = Date.now();
const H = 3_600_000;
const sessions = new Map();
const messages = new Map(); // sessionID -> [{info, parts}]
const clients = new Set();
let seq = 0;
const id = (p) => `${p}_${(now + ++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const providers = [
  {
    id: "opencode",
    name: "OpenCode Zen",
    env: ["OPENCODE_API_KEY"],
    models: {
      "claude-sonnet-5-5": { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", reasoning: true, attachment: true, cost: { input: 2, output: 10, cache_read: 0.2 }, limit: { context: 1000000, output: 64000 } },
      "claude-haiku-5-5": { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", reasoning: false, attachment: true, cost: { input: 0.1, output: 0.5 }, limit: { context: 200000, output: 32000 } },
      "glm-5": { id: "glm-5", name: "GLM-5", reasoning: true, attachment: false, cost: { input: 0.6, output: 2.2 }, limit: { context: 200000, output: 32000 } },
      "free-preview": { id: "free-preview", name: "Free Preview", reasoning: false, attachment: false, cost: { input: 0, output: 0 }, limit: { context: 128000, output: 16000 } },
    },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    env: ["OPENROUTER_API_KEY"],
    models: {
      "deepseek/deepseek-v4": { id: "deepseek/deepseek-v4", name: "DeepSeek V4", reasoning: true, attachment: false, cost: { input: 0.27, output: 1.1 }, limit: { context: 128000, output: 8000 } },
      "moonshotai/kimi-k3": { id: "moonshotai/kimi-k3", name: "Kimi K3", reasoning: true, attachment: false, cost: { input: 0.6, output: 2.5 }, limit: { context: 256000, output: 16000 } },
    },
  },
  {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    models: {
      "claude-opus-5-5": { id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true, attachment: true, cost: { input: 5, output: 25 }, limit: { context: 1000000, output: 64000 } },
    },
  },
];

function seed() {
  const demo = [
    ["Fix flaky auth test", "opencode", "claude-sonnet-5-5", 3, [0.42, 0.18, 0.09]],
    ["Waybar config for Hyprland", "openrouter", "deepseek/deepseek-v4", 26, [0.012, 0.008]],
    ["Refactor balance ledger", "opencode", "glm-5", 50, [0.05, 0.07, 0.03]],
    ["Explain PKGBUILD", "anthropic", "claude-opus-5-5", 200, [1.12]],
  ];
  for (const [title, providerID, modelID, ageH, costs] of demo) {
    const s = { id: id("ses"), projectID: "demo", directory: "/home/me/code/demo", title, version: "demo", time: { created: now - ageH * H, updated: now - ageH * H + 600_000 } };
    sessions.set(s.id, s);
    const list = [];
    costs.forEach((cost, i) => {
      const t = now - ageH * H + i * 120_000;
      const u = { id: id("msg"), sessionID: s.id, role: "user", time: { created: t }, agent: "build", model: { providerID, modelID } };
      list.push({ info: u, parts: [{ id: id("prt"), sessionID: s.id, messageID: u.id, type: "text", text: i ? "Looks good — can you also add tests?" : `${title}, please.` }] });
      const a = { id: id("msg"), sessionID: s.id, role: "assistant", parentID: u.id, providerID, modelID, mode: "build", path: { cwd: s.directory, root: s.directory }, cost, tokens: { input: 12000, output: 1800, reasoning: 400, cache: { read: 9000, write: 0 } }, time: { created: t + 1000, completed: t + 9000 } };
      list.push({
        info: a,
        parts: [
          { id: id("prt"), sessionID: s.id, messageID: a.id, type: "tool", callID: "c1", tool: "read", state: { status: "completed", input: { filePath: "src/auth.test.ts" }, output: "…", title: "src/auth.test.ts", metadata: {}, time: { start: t, end: t + 300 } } },
          { id: id("prt"), sessionID: s.id, messageID: a.id, type: "text", text: "Done. The test raced the token refresh; I now **await** it:\n\n```ts\nawait session.refresh()\nexpect(session.valid).toBe(true)\n```\n\n- removed the `setTimeout`\n- added a retry-free assertion" },
        ],
      });
    });
    messages.set(s.id, list);
  }
}
seed();

function emit(type, properties) {
  const line = `data: ${JSON.stringify({ type, properties })}\n\n`;
  for (const res of clients) res.write(line);
}

async function reply(sessionID, body) {
  const text = body?.parts?.find((p) => p.type === "text")?.text || "";
  const model = body?.model || { providerID: "opencode", modelID: "claude-sonnet-5-5" };
  const t = Date.now();
  const u = { id: id("msg"), sessionID, role: "user", time: { created: t }, agent: body?.agent || "build", model };
  const up = { id: id("prt"), sessionID, messageID: u.id, type: "text", text };
  messages.get(sessionID).push({ info: u, parts: [up] });
  emit("message.updated", { info: u });
  emit("message.part.updated", { part: up });
  emit("session.status", { sessionID, status: { type: "busy" } });

  const a = { id: id("msg"), sessionID, role: "assistant", parentID: u.id, ...model, mode: "build", path: { cwd: "/demo", root: "/demo" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: t + 50 } };
  const entry = { info: a, parts: [] };
  messages.get(sessionID).push(entry);
  emit("message.updated", { info: a });

  const tool = { id: id("prt"), sessionID, messageID: a.id, type: "tool", callID: "c1", tool: "bash", state: { status: "running", input: { command: "git status" }, title: "git status", time: { start: Date.now() } } };
  entry.parts.push(tool);
  emit("message.part.updated", { part: tool });
  await sleep(500);
  tool.state = { status: "completed", input: tool.state.input, output: "nothing to commit, working tree clean", title: "git status", metadata: {}, time: { start: tool.state.time.start, end: Date.now() } };
  emit("message.part.updated", { part: tool });

  const answer = `This is **demo mode** — no real model was called.\n\nYou said: _${text.slice(0, 200)}_\n\nConnect a real \`opencode serve\` by unsetting \`OCB_DEMO\` and setting \`OPENCODE_URL\`.\n\n\`\`\`bash\nopencode serve --port 4096\n\`\`\``;
  const part = { id: id("prt"), sessionID, messageID: a.id, type: "text", text: "", time: { start: Date.now() } };
  entry.parts.push(part);
  for (const word of answer.split(/(?<=\s)/)) {
    part.text += word;
    emit("message.part.updated", { part: { ...part }, delta: word });
    await sleep(25);
  }
  a.cost = 0.0123;
  a.tokens = { input: 3200, output: 240, reasoning: 0, cache: { read: 0, write: 0 } };
  a.time.completed = Date.now();
  a.finish = "stop";
  emit("message.updated", { info: a });
  const s = sessions.get(sessionID);
  s.time.updated = Date.now();
  if (s.title.startsWith("New session")) s.title = text.slice(0, 40) || s.title;
  emit("session.updated", { info: s });
  emit("session.status", { sessionID, status: { type: "idle" } });
  emit("session.idle", { sessionID });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let raw = "";
  for await (const c of req) raw += c;
  return raw ? JSON.parse(raw) : undefined;
}

export function startMock() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    const m = req.method;
    let r;
    if (p === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (p === "/provider") return send(res, 200, { all: providers, connected: providers.map((x) => x.id), default: { opencode: "claude-sonnet-5-5" } });
    if (p === "/provider/auth") return send(res, 200, { anthropic: [{ type: "oauth", label: "Claude Pro/Max" }, { type: "api", label: "Manually enter API Key" }], openrouter: [{ type: "api", label: "API key" }], opencode: [{ type: "api", label: "API key" }] });
    if ((r = p.match(/^\/provider\/([^/]+)\/oauth\/authorize$/))) return send(res, 200, { url: "https://example.com/oauth-demo", method: "code", instructions: "Demo: paste any code." });
    if (p.match(/^\/provider\/([^/]+)\/oauth\/callback$/)) return send(res, 200, true);
    if (p.match(/^\/auth\//) && m === "PUT") return send(res, 200, true);
    if (p === "/config/providers") return send(res, 200, { providers: providers.map((x) => ({ ...x, source: "api" })), default: { opencode: "claude-sonnet-5-5" } });
    if (p === "/config") return send(res, 200, { model: "opencode/claude-sonnet-5-5" });
    if (p === "/agent") return send(res, 200, [{ name: "build", mode: "primary", builtIn: true }, { name: "plan", mode: "primary", builtIn: true }]);
    if (p === "/path") return send(res, 200, { state: "~/.local/state/opencode", config: "~/.config/opencode", worktree: "/home/me/code/demo", directory: "/home/me/code/demo" });
    if (p === "/project/current") return send(res, 200, { id: "demo", worktree: "/home/me/code/demo", vcs: "git", time: { created: now } });
    if (p === "/session/status") return send(res, 200, {});
    if (p === "/session" && m === "GET") return send(res, 200, [...sessions.values()].sort((a, b) => b.time.updated - a.time.updated));
    if (p === "/session" && m === "POST") {
      const body = await readBody(req);
      const s = { id: id("ses"), projectID: "demo", directory: "/home/me/code/demo", title: body?.title || `New session - ${new Date().toISOString()}`, version: "demo", time: { created: Date.now(), updated: Date.now() } };
      sessions.set(s.id, s);
      messages.set(s.id, []);
      emit("session.created", { info: s });
      return send(res, 200, s);
    }
    if ((r = p.match(/^\/session\/([^/]+)$/))) {
      if (!sessions.has(r[1])) return send(res, 404, { name: "NotFoundError" });
      if (m === "DELETE") {
        sessions.delete(r[1]);
        emit("session.deleted", { info: { id: r[1] } });
        return send(res, 200, true);
      }
      if (m === "PATCH") Object.assign(sessions.get(r[1]), await readBody(req));
      return send(res, 200, sessions.get(r[1]));
    }
    if ((r = p.match(/^\/session\/([^/]+)\/message$/))) return send(res, 200, messages.get(r[1]) || []);
    if ((r = p.match(/^\/session\/([^/]+)\/prompt_async$/))) {
      const body = await readBody(req);
      res.writeHead(204).end();
      reply(r[1], body);
      return;
    }
    if (p.match(/^\/session\/([^/]+)\/abort$/)) return send(res, 200, true);
    send(res, 404, { name: "NotFoundError", path: p });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
}
