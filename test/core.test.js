// Run with: npm run check
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.OCB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-test-"));
process.env.OCB_PASSWORD = "test";

const { markdown } = await import("../public/js/markdown.js");
const { summarize, spendSince } = await import("../server/usage.js");
const { writeBudgets, readBudgets, maskKey } = await import("../server/balances.js");

test("markdown escapes HTML and only allows http(s) links", () => {
  const html = markdown('<img src=x onerror=alert(1)> [a](javascript:alert(1)) [b](https://ok.dev)');
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes('href="javascript'));
  assert.ok(html.includes('href="https://ok.dev"'));
});

test("markdown renders code fences, lists and inline code", () => {
  const html = markdown("hi `x`\n\n```js\nconst a = '<b>'\n```\n\n- one\n- two");
  assert.match(html, /<code>x<\/code>/);
  assert.match(html, /<pre><code>const a = &#39;&lt;b&gt;&#39;<\/code><\/pre>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
});

test("summarize builds per-model rolling windows", () => {
  const now = 1_000_000_000_000;
  const H = 3_600_000;
  const e = (modelID, cost, ago) => ({ providerID: "p", modelID, cost, time: now - ago, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  const s = summarize([e("a", 1, 1 * H), e("a", 2, 30 * H), e("b", 4, 40 * 24 * H)], now);
  assert.equal(s.models["p/a"].windows["5h"], 1);
  assert.equal(s.models["p/a"].windows.week, 3);
  assert.equal(s.models["p/b"].windows.month, 0);
  assert.equal(s.providers.p.cost, 7);
  assert.equal(spendSince([e("a", 1, H), e("a", 2, 3 * H)], "p", now - 2 * H), 1);
});

test("budgets are validated and get Go-style window splits", () => {
  writeBudgets({ providers: { opencode: { balance: "12.5" }, bad: { balance: "x" } }, limits: { "opencode/glm": { monthly: 15 }, "x/y": { monthly: -1 } } });
  const b = readBudgets();
  assert.equal(b.providers.opencode.balance, 12.5);
  assert.equal(b.providers.bad, undefined);
  assert.deepEqual(b.limits["opencode/glm"].split, { "5h": 0.2, week: 0.5, month: 1 });
  assert.equal(b.limits["x/y"], undefined);
});

test("keys are masked", () => {
  assert.equal(maskKey("sk-or-v1-abcdef123456"), "sk-o…3456");
  assert.equal(maskKey("short"), "••••");
});
