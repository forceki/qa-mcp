// End-to-end tests: spawn the built MCP server over stdio and drive it against a local fixture site.
// Run with: npm test   (builds first)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, statSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORM = `<!doctype html><html><head><title>Fixture</title></head><body>
<h1>Fixture Form</h1>
<input id="name" placeholder="Your name">
<input id="secret" type="password">
<select id="color"><option value="r">Red</option><option value="b">Blue</option></select>
<label><input id="agree" type="checkbox"> I agree</label>
<input id="file" type="file">
<button id="hover" onmouseenter="document.getElementById('out').textContent='hovered'">Hover me</button>
<button id="go" onclick="
  const n=document.getElementById('name').value;
  const c=document.getElementById('color');
  document.getElementById('out').textContent='Hello '+n+' / '+c.options[c.selectedIndex].text+' / '+document.getElementById('agree').checked;
  console.error('boom from page');
  fetch('/missing');
">Go</button>
<p id="out"></p>
<div style="height:3000px"></div><footer id="bottom">The end</footer>
</body></html>`;

let httpServer, baseUrl, evidence, client;

before(async () => {
  const items = new Map();
  httpServer = http.createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const send = (code, obj, extra = {}) =>
          res.writeHead(code, { "Content-Type": "application/json", ...extra }).end(JSON.stringify(obj));
        const body = raw ? JSON.parse(raw) : {};
        if (req.method === "POST" && req.url === "/api/login")
          return send(200, { token: "tok-secret-123", user: { id: 7, name: "ana" } }, { "Set-Cookie": "sid=cookie-secret-9; Path=/" });
        if (req.method === "POST" && req.url === "/api/items") {
          const id = String(items.size + 100);
          items.set(id, { id, ...body });
          return send(201, { data: { id, ...body } });
        }
        const m = req.url.match(/^\/api\/items\/(\d+)$/);
        if (m && req.method === "GET") return items.has(m[1]) ? send(200, items.get(m[1])) : send(404, { error: "not found" });
        if (m && req.method === "DELETE") return items.delete(m[1]) ? send(204, {}) : send(404, { error: "not found" });
        if (req.url === "/api/echo") return send(200, { echoed: raw });
        if (req.url === "/api/echo-auth") return send(200, { auth: req.headers.authorization ?? null });
        return send(404, { error: "no route" });
      });
      return;
    }
    const html = (body) => res.writeHead(200, { "Content-Type": "text/html" }).end(`<!doctype html><title>t</title>${body}`);
    if (req.url === "/tabs")
      return html('<h1>Tabs Home</h1><a id="blank" href="/popup" target="_blank">Open popup</a><button id="winopen" onclick="window.open(\'/popup2\')">window.open</button>');
    if (req.url === "/popup") return html("<h1>Popup One</h1>");
    if (req.url === "/popup2") return html('<h1>Popup Two</h1><button id="closeme" onclick="window.close()">close me</button>');
    if (req.url === "/dialogs")
      return html(`<h1>Dialogs</h1><p id="r"></p>
        <button id="alert" onclick="alert('Heads up')">alert</button>
        <button id="confirm" onclick="document.getElementById('r').textContent = confirm('Delete item?') ? 'deleted' : 'kept'">confirm</button>
        <button id="prompt" onclick="document.getElementById('r').textContent = 'hi ' + prompt('Your name?', 'anon')">prompt</button>`);
    if (req.url === "/me") {
      const authed = /(?:^|;\s*)sid=cookie-secret-9/.test(req.headers.cookie ?? "");
      res.writeHead(authed ? 200 : 401, { "Content-Type": "text/html" }).end(authed ? "<h1>Hello session</h1>" : "<h1>Please log in</h1>");
      return;
    }
    if (req.url === "/ls-set") {
      res.writeHead(200, { "Content-Type": "text/html" }).end('<p>set</p><script>localStorage.setItem("token","ls-token-77")</script>');
      return;
    }
    if (req.url === "/ls-read") {
      res.writeHead(200, { "Content-Type": "text/html" }).end('<p id="v"></p><script>document.getElementById("v").textContent="ls="+(localStorage.getItem("token")||"none")</script>');
      return;
    }
    if (req.url === "/protected") {
      const ok = req.headers.authorization === "Basic " + Buffer.from("alice:s3cret").toString("base64");
      if (!ok) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="dev"' }).end("denied");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" }).end("<h1>Welcome alice</h1>");
      return;
    }
    if (req.url === "/form") {
      res.writeHead(200, { "Content-Type": "text/html" }).end(FORM);
      return;
    }
    res.writeHead(404).end("nope");
  });
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

  evidence = mkdtempSync(path.join(tmpdir(), "qa-evidence-"));
  client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: [path.join(root, "dist", "server.js")],
      env: { ...process.env, QA_EVIDENCE_DIR: evidence, QA_STATE_DIR: path.join(evidence, "states"), QA_TEST_PASS: "s3cret", QA_ASSERT_TIMEOUT_MS: "1500", QA_TIMEOUT_MS: "2000" },
    }),
  );
});

after(async () => {
  await client?.close();
  await new Promise((r) => httpServer?.close(r));
  if (evidence) rmSync(evidence, { recursive: true, force: true });
});

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content[0].text;
  let json;
  try {
    json = JSON.parse(t);
  } catch {}
  return { isError: Boolean(r.isError), text: t, json };
}

test("lists all tools", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "qa_action",
    "qa_assert",
    "qa_dialog",
    "qa_extract",
    "qa_finish_session",
    "qa_inspect_dom",
    "qa_list_states",
    "qa_navigate",
    "qa_request",
    "qa_save_state",
    "qa_start_session",
    "qa_tab",
  ]);
});

test("tools fail cleanly without a session", async () => {
  const r = await call("qa_navigate", { url: baseUrl, step_description: "x" });
  assert.equal(r.isError, true);
  assert.match(r.text, /No active session/);
});

test("full flow: every action and assertion type, report, screenshots", { timeout: 120_000 }, async () => {
  const start = await call("qa_start_session", { test_name: "Full Flow" });
  assert.equal(start.isError, false);
  const dir = start.json.evidence_dir;

  const ok = async (name, args) => {
    const r = await call(name, args);
    assert.equal(r.isError, false, `${name} ${JSON.stringify(args)} -> ${r.text}`);
    assert.equal(r.json.status, "pass");
    return r.json;
  };

  await ok("qa_navigate", { url: `${baseUrl}/form`, step_description: "open form" });
  await ok("qa_assert", { type: "text_present", expected: "Fixture Form", step_description: "heading" });
  await ok("qa_assert", { type: "url_matches", expected: "/form", step_description: "url substring" });
  await ok("qa_assert", { type: "url_matches", expected: "/\\/fo.m$/", step_description: "url regex" });
  await ok("qa_assert", { type: "element_visible", expected: "#go", step_description: "button visible" });
  await ok("qa_action", { action: "fill", selector: "#name", value: "Ana", step_description: "fill" });
  await ok("qa_action", { action: "fill", selector: "#secret", value: "{{env:QA_TEST_PASS}}", step_description: "env fill" });
  await ok("qa_action", { action: "select", selector: "#color", value: "Blue", step_description: "select by label" });
  await ok("qa_action", { action: "select", selector: "#color", value: "r", step_description: "select by value" });
  await ok("qa_action", { action: "select", selector: "#color", value: "b", step_description: "select by value again" });
  await ok("qa_action", { action: "check", selector: "#agree", step_description: "check" });
  await ok("qa_action", { action: "uncheck", selector: "#agree", step_description: "uncheck" });
  await ok("qa_action", { action: "check", selector: "#agree", step_description: "check again" });
  await ok("qa_action", { action: "hover", selector: "#hover", step_description: "hover" });
  await ok("qa_assert", { type: "text_present", expected: "hovered", step_description: "hover effect" });
  const fixture = path.join(evidence, "upload.txt");
  writeFileSync(fixture, "hi");
  await ok("qa_action", { action: "upload", selector: "#file", value: fixture, step_description: "upload" });
  await ok("qa_action", { action: "scroll", selector: "#bottom", step_description: "scroll" });
  await ok("qa_action", { action: "dblclick", selector: "#hover", step_description: "dblclick" });
  const go = await ok("qa_action", { action: "click", selector: "#go", step_description: "submit" });
  await ok("qa_assert", { type: "text_present", expected: "Hello Ana / Blue / true", step_description: "result text" });
  await ok("qa_action", { action: "press", selector: "#name", value: "Enter", step_description: "press" });

  // Console error + 404 during the click step should be reported even though the step passed.
  assert.ok(go.browser_issues?.some((i) => /boom from page/.test(i)), "console error captured");

  const inspect = await call("qa_inspect_dom");
  assert.equal(inspect.isError, false);
  assert.ok(inspect.json.interactive_elements.some((e) => e.selector === "#go"));
  assert.match(inspect.json.aria_snapshot, /button/);

  const fin = await call("qa_finish_session", { summary_notes: "all good" });
  assert.equal(fin.json.result, "PASS");
  assert.equal(fin.json.failed, 0);
  const readme = readFileSync(fin.json.report, "utf8");
  assert.match(readme, /!\[Step 1\]\(step-1\.png\)/);
  assert.match(readme, /Browser issues/);
  assert.ok(!readme.includes("s3cret"), "env secret must not leak into the report");
  for (let i = 1; i <= fin.json.steps; i++) assert.ok(existsSync(path.join(dir, `step-${i}.png`)), `step-${i}.png exists`);
});

test("failed step records diagnostics and a FAIL report", { timeout: 60_000 }, async () => {
  const start = await call("qa_start_session", { test_name: "failure" });
  const dir = start.json.evidence_dir;
  await call("qa_navigate", { url: `${baseUrl}/form`, step_description: "open" });

  const bad = await call("qa_action", { action: "click", selector: "#does-not-exist", step_description: "click missing" });
  assert.equal(bad.isError, true);
  assert.equal(bad.json.status, "fail");
  assert.match(bad.json.error, /Timeout/);
  assert.ok(existsSync(bad.json.diagnostics.console));
  assert.match(readFileSync(bad.json.diagnostics.aria, "utf8"), /Fixture Form/);

  const missingVal = await call("qa_action", { action: "fill", selector: "#name", step_description: "no value" });
  assert.equal(missingVal.isError, true);
  assert.match(missingVal.json.error, /"value" is required/);

  const noText = await call("qa_assert", { type: "text_present", expected: "not on page", step_description: "absent text" });
  assert.equal(noText.isError, true);
  const noUrl = await call("qa_assert", { type: "url_matches", expected: "/nowhere", step_description: "wrong url" });
  assert.equal(noUrl.isError, true);

  const badEnv = await call("qa_action", { action: "fill", selector: "#name", value: "{{env:NOPE_NOT_SET}}", step_description: "bad env" });
  assert.equal(badEnv.isError, true);
  assert.match(badEnv.json.error, /NOPE_NOT_SET is not set/);

  const fin = await call("qa_finish_session", {});
  assert.equal(fin.json.result, "FAIL");
  const readme = readFileSync(fin.json.report, "utf8");
  assert.match(readme, /Diagnostics:\*\* \[console log\]\(step-2-console\.txt\)/);
  assert.ok(existsSync(path.join(dir, "step-2-aria.yml")));
});

test("basic auth: correct credentials pass, wrong ones fail", { timeout: 60_000 }, async () => {
  const good = await call("qa_start_session", {
    test_name: "auth good",
    basic_auth_username: "alice",
    basic_auth_password: "{{env:QA_TEST_PASS}}",
  });
  assert.equal(good.json.basic_auth, true);
  await call("qa_navigate", { url: `${baseUrl}/protected`, step_description: "open protected" });
  const seen = await call("qa_assert", { type: "text_present", expected: "Welcome alice", step_description: "welcome" });
  assert.equal(seen.json.status, "pass");
  assert.equal((await call("qa_finish_session", {})).json.result, "PASS");

  await call("qa_start_session", { test_name: "auth bad", basic_auth_username: "alice", basic_auth_password: "wrong" });
  await call("qa_navigate", { url: `${baseUrl}/protected`, step_description: "open protected" });
  const denied = await call("qa_assert", { type: "text_present", expected: "Welcome alice", step_description: "welcome" });
  assert.equal(denied.json.status, "fail");
  assert.equal((await call("qa_finish_session", {})).json.result, "FAIL");
});

test("starting a new session closes the previous one", { timeout: 60_000 }, async () => {
  const a = await call("qa_start_session", { test_name: "first" });
  const b = await call("qa_start_session", { test_name: "second" });
  assert.notEqual(a.json.evidence_dir, b.json.evidence_dir);
  assert.equal((await call("qa_finish_session", {})).json.steps, 0);
});

test("API: create -> use -> delete with saved variables, placeholders and report details", { timeout: 60_000 }, async () => {
  const start = await call("qa_start_session", { test_name: "api flow" });
  const dir = start.json.evidence_dir;
  await call("qa_navigate", { url: `${baseUrl}/form`, step_description: "open app (sets origin for relative URLs)" });

  const login = await call("qa_request", {
    method: "POST",
    url: "/api/login",
    body: { username: "ana", password: "{{env:QA_TEST_PASS}}" },
    save: { token: "token", user_id: "user.id" },
    expect_json: { "user.name": "ana" },
    step_description: "log in via API",
    report_note: "Token is saved but must never be printed",
  });
  assert.equal(login.isError, false, login.text);
  assert.equal(login.json.api.status, 200);
  assert.ok(!login.text.includes("tok-secret-123"), "token redacted from tool output");
  assert.ok(!login.text.includes("s3cret"), "env secret redacted from tool output");

  const created = await call("qa_request", {
    method: "POST",
    url: "/api/items",
    headers: { Authorization: "Bearer {{var:token}}" },
    body: { name: "item-{{rand}}", owner: "{{var:user_id}}" },
    expect_status: 201,
    save: { item_id: "data.id" },
    step_description: "create item",
  });
  assert.equal(created.isError, false, created.text);
  assert.deepEqual(created.json.api.saved_variables, ["item_id"]);

  const fetched = await call("qa_request", {
    method: "GET",
    url: "/api/items/{{var:item_id}}",
    expect_json: { owner: "7" },
    expect_body_contains: "item-{{rand}}",
    step_description: "read item back",
    report_detail: "summary",
  });
  assert.equal(fetched.isError, false, fetched.text);

  // Shares the browser's Basic Auth / cookies: also works with explicit absolute URL.
  assert.equal((await call("qa_request", { method: "DELETE", url: `${baseUrl}/api/items/{{var:item_id}}`, expect_status: 204, step_description: "cleanup" })).isError, false);
  const gone = await call("qa_request", { method: "GET", url: "/api/items/{{var:item_id}}", expect_status: [404, 410], step_description: "gone" });
  assert.equal(gone.isError, false, gone.text);

  // Failure paths
  const wrongStatus = await call("qa_request", { method: "GET", url: "/api/items/{{var:item_id}}", step_description: "expects 2xx but is 404" });
  assert.equal(wrongStatus.isError, true);
  assert.match(wrongStatus.json.error, /Expected status 2xx, got 404/);
  const badJson = await call("qa_request", { method: "GET", url: "/api/echo-auth", expect_json: { auth: "nope" }, step_description: "wrong json" });
  assert.equal(badJson.isError, true);
  assert.match(badJson.json.error, /JSON auth/);
  const noVar = await call("qa_request", { method: "GET", url: "/api/items/{{var:nothing}}", step_description: "unknown var" });
  assert.equal(noVar.isError, true);
  assert.match(noVar.json.error, /Variable "nothing" is not set/);
  const noPath = await call("qa_request", { method: "GET", url: "/api/echo-auth", save: { x: "does.not.exist" }, step_description: "bad save path" });
  assert.equal(noPath.isError, true);
  assert.match(noPath.json.error, /not found in response/);

  const fin = await call("qa_finish_session", { summary_notes: "api" });
  assert.equal(fin.json.failed, 4);
  const readme = readFileSync(fin.json.report, "utf8");
  assert.match(readme, /`POST http:\/\/127\.0\.0\.1:\d+\/api\/items`/);
  assert.match(readme, /`201 Created`/);
  assert.match(readme, /Saved variables:\*\* `item_id`/);
  assert.match(readme, /> Token is saved but must never be printed/);
  assert.match(readme, /"name": "item-[0-9a-f]{8}"/);
  assert.ok(!readme.includes("tok-secret-123"), "token not in report");
  assert.ok(!readme.includes("cookie-secret-9"), "cookie not in report");
  assert.ok(!readme.includes("s3cret"), "env secret not in report");
  assert.ok(readme.includes("Authorization: ***"), "auth header redacted");
  // summary mode: the GET step shows request/response lines but no body blocks
  const getSection = readme.split("### Step 4:")[1].split("### Step 5:")[0];
  assert.ok(!getSection.includes("Response details"), "summary mode omits bodies");
  // API steps have no page screenshot
  assert.ok(!existsSync(path.join(dir, "step-2.png")));
});

test("API: secrets echoed back inside string fields are masked", { timeout: 60_000 }, async () => {
  await call("qa_start_session", { test_name: "echo" });
  const r = await call("qa_request", {
    method: "POST",
    url: `${baseUrl}/api/echo`,
    headers: { Authorization: "Bearer bearer-token-xyz" },
    body: { password: "hunter22-pass", note: "ok" },
    step_description: "echo",
  });
  assert.equal(r.isError, false, r.text);
  assert.ok(!r.text.includes("hunter22-pass"), "tool output masks echoed password");
  const fin = await call("qa_finish_session", {});
  const readme = readFileSync(fin.json.report, "utf8");
  assert.ok(!readme.includes("hunter22-pass"), "report masks echoed password");
  assert.ok(!readme.includes("bearer-token-xyz"), "report masks bearer token");
});

test("Basic auth is shared with qa_request", { timeout: 60_000 }, async () => {
  await call("qa_start_session", { test_name: "api basic auth", basic_auth_username: "alice", basic_auth_password: "{{env:QA_TEST_PASS}}" });
  const r = await call("qa_request", { method: "GET", url: `${baseUrl}/protected`, expect_body_contains: "Welcome alice", step_description: "protected via API" });
  assert.equal(r.isError, false, r.text);
  const fin = await call("qa_finish_session", {});
  assert.ok(!readFileSync(fin.json.report, "utf8").includes("s3cret"));
});

test("qa_extract: read page values into variables and reuse them", { timeout: 60_000 }, async () => {
  await call("qa_start_session", { test_name: "extract" });
  await call("qa_navigate", { url: `${baseUrl}/form`, step_description: "open" });
  const ok = async (args) => {
    const r = await call("qa_extract", { step_description: "extract", ...args });
    assert.equal(r.isError, false, JSON.stringify(args) + " -> " + r.text);
    return r.json;
  };

  await ok({ source: "text", selector: "h1", save_as: "heading" });
  await ok({ source: "title", save_as: "page_title" });
  await ok({ source: "url", regex: "(\\d+)/form$", save_as: "port" });
  await ok({ source: "attribute", selector: "#name", attribute: "placeholder", save_as: "ph" });
  const count = await ok({ source: "count", selector: "#color option", save_as: "n_options" });
  assert.match(count.detail, /"2"/);

  // Round trip: fill -> extract value -> regex from result text -> reuse in assert/fill
  await call("qa_action", { action: "fill", selector: "#name", value: "Ana-{{rand}}", step_description: "fill" });
  await call("qa_action", { action: "click", selector: "#go", step_description: "go" });
  await ok({ source: "value", selector: "#name", save_as: "typed" });
  await ok({ source: "text", selector: "#out", regex: "Hello (\\S+) /", save_as: "greeted" });
  const reuse = await call("qa_assert", { type: "text_present", expected: "Hello {{var:greeted}} / Red", step_description: "uses extracted var" });
  assert.equal(reuse.json.status, "pass", reuse.text);
  const typedBack = await call("qa_action", { action: "fill", selector: "#name", value: "{{var:heading}}!", step_description: "reuse heading" });
  assert.equal(typedBack.json.status, "pass");
  assert.equal((await ok({ source: "value", selector: "#name", save_as: "check" })).detail, 'Extracted value of #name -> {{var:check}} = "Fixture Form!"');

  // Failure paths
  for (const [args, re] of [
    [{ source: "text", selector: "#nope", save_as: "x" }, /Timeout/],
    [{ source: "text", selector: "h1", regex: "zzz(\\d+)", save_as: "x" }, /did not match/],
    [{ source: "attribute", selector: "#name", save_as: "x" }, /"attribute" is required/],
    [{ source: "attribute", selector: "#name", attribute: "data-none", save_as: "x" }, /not found/],
    [{ source: "text", save_as: "x" }, /"selector" is required/],
  ]) {
    const r = await call("qa_extract", { step_description: "bad", ...args });
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.json.error, re);
  }

  // Secrets extracted under sensitive names are masked
  await call("qa_action", { action: "fill", selector: "#secret", value: "pw-value-123", step_description: "pw" });
  const sec = await call("qa_extract", { source: "value", selector: "#secret", save_as: "password_copy", step_description: "grab" });
  assert.ok(!sec.text.includes("pw-value-123"), "sensitive extract masked in output");
  const fin = await call("qa_finish_session", {});
  assert.ok(!readFileSync(fin.json.report, "utf8").includes("pw-value-123"), "sensitive extract masked in report");
});

test("saved login state: save once, reuse in later sessions", { timeout: 90_000 }, async () => {
  assert.deepEqual((await call("qa_list_states")).json.states, [], "no states yet");

  // Session A: log in (HttpOnly-style cookie via API + localStorage via page), then save.
  await call("qa_start_session", { test_name: "login once" });
  await call("qa_navigate", { url: `${baseUrl}/me`, step_description: "anonymous first" });
  assert.equal((await call("qa_assert", { type: "text_present", expected: "Please log in", step_description: "logged out" })).json.status, "pass");
  assert.equal((await call("qa_request", { method: "POST", url: "/api/login", body: { username: "ana" }, step_description: "login" })).isError, false);
  await call("qa_navigate", { url: `${baseUrl}/ls-set`, step_description: "set localStorage" });
  const saved = await call("qa_save_state", { name: "dev-admin" });
  assert.equal(saved.isError, false, saved.text);
  assert.match(saved.json.detail, /Saved state "dev-admin" \(\d+ cookies/);
  const file = path.join(evidence, "states", "dev-admin.json");
  assert.ok(existsSync(file), "state file written outside the run folder");
  assert.equal((statSync(file).mode & 0o777).toString(8), "600", "state file is private");
  assert.ok(!file.startsWith(JSON.parse((await call("qa_finish_session", {})).text).report.replace(/README\.md$/, "")), "not in evidence dir");

  const list = (await call("qa_list_states")).json.states;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "dev-admin");
  assert.ok(list[0].cookies >= 1);
  assert.ok(list[0].origins.some((o) => o.startsWith("http://127.0.0.1")));

  // Session B: loads state -> already logged in, localStorage restored, no login steps.
  const b = await call("qa_start_session", { test_name: "reuse", load_state: "dev-admin" });
  assert.equal(b.json.loaded_state, "dev-admin");
  await call("qa_navigate", { url: `${baseUrl}/me`, step_description: "open /me" });
  assert.equal((await call("qa_assert", { type: "text_present", expected: "Hello session", step_description: "logged in" })).json.status, "pass");
  await call("qa_navigate", { url: `${baseUrl}/ls-read`, step_description: "read localStorage" });
  assert.equal((await call("qa_assert", { type: "text_present", expected: "ls=ls-token-77", step_description: "storage restored" })).json.status, "pass");
  // API calls share the loaded cookies too
  assert.equal((await call("qa_request", { method: "GET", url: "/me", expect_body_contains: "Hello session", step_description: "api sees cookie" })).isError, false);
  const fin = await call("qa_finish_session", {});
  assert.equal(fin.json.result, "PASS");
  const readme = readFileSync(fin.json.report, "utf8");
  assert.match(readme, /Login state:\*\* loaded `dev-admin`/);
  assert.ok(!readme.includes("cookie-secret-9"));

  // Session C: no state -> anonymous again (states are opt-in and isolated).
  await call("qa_start_session", { test_name: "anonymous" });
  await call("qa_navigate", { url: `${baseUrl}/me`, step_description: "open /me" });
  assert.equal((await call("qa_assert", { type: "text_present", expected: "Please log in", step_description: "still anonymous" })).json.status, "pass");
  await call("qa_finish_session", {});
});

test("saved login state: errors are clear and do not kill a running session", { timeout: 60_000 }, async () => {
  await call("qa_start_session", { test_name: "running" });
  await call("qa_navigate", { url: `${baseUrl}/form`, step_description: "open" });

  const missing = await call("qa_start_session", { test_name: "x", load_state: "nope" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /"nope" not found\. Available: dev-admin/);
  const bad = await call("qa_start_session", { test_name: "x", load_state: "../etc/passwd" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Invalid state name/);
  assert.equal((await call("qa_save_state", { name: "../evil" })).isError, true);

  // The original session survived both failed starts.
  const still = await call("qa_assert", { type: "text_present", expected: "Fixture Form", step_description: "still alive" });
  assert.equal(still.json.status, "pass");
  await call("qa_finish_session", {});
});

test("tabs: popups auto-switch, list/switch/close/new, self-closing tab", { timeout: 90_000 }, async () => {
  await call("qa_start_session", { test_name: "tabs" });
  await call("qa_navigate", { url: `${baseUrl}/tabs`, step_description: "open tabs page" });
  const pass = async (args, label) => {
    const r = await call("qa_assert", { step_description: label, ...args });
    assert.equal(r.json.status, "pass", `${label}: ${r.text}`);
  };

  // target=_blank link: the step reports the new tab and continues in it
  const click = await call("qa_action", { action: "click", selector: "#blank", step_description: "open popup" });
  assert.match(click.json.new_tab, /^#2 http:\/\/127\.0\.0\.1:\d+\/popup/);
  await pass({ type: "text_present", expected: "Popup One" }, "now on popup");
  let list = (await call("qa_tab", { action: "list" })).json.tabs;
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((t) => t.current), [false, true]);

  // switch back and forth; text on the other tab is not visible
  assert.equal((await call("qa_tab", { action: "switch", index: 1 })).json.status, "pass");
  await pass({ type: "text_present", expected: "Tabs Home" }, "back on tab 1");
  const absent = await call("qa_assert", { type: "text_present", expected: "Popup One", step_description: "popup text not on tab 1" });
  assert.equal(absent.isError, true);

  // close the popup tab (index 2) while on tab 1: stays on 1
  const closed = await call("qa_tab", { action: "close", index: 2 });
  assert.equal(closed.json.status, "pass", closed.text);
  assert.match(closed.json.detail, /Current tab is now #1/);
  assert.equal((await call("qa_tab", { action: "list" })).json.tabs.length, 1);
  const last = await call("qa_tab", { action: "close" });
  assert.equal(last.isError, true);
  assert.match(last.json.error, /Cannot close the last tab/);

  // new tab with url becomes current
  const nt = await call("qa_tab", { action: "new", url: `${baseUrl}/form` });
  assert.equal(nt.json.status, "pass", nt.text);
  await pass({ type: "text_present", expected: "Fixture Form" }, "new tab loaded");
  assert.equal((await call("qa_tab", { action: "list" })).json.tabs.length, 2);

  // window.open from tab 1, then the popup closes itself
  await call("qa_tab", { action: "switch", index: 1 });
  const wo = await call("qa_action", { action: "click", selector: "#winopen", step_description: "window.open" });
  assert.match(wo.json.new_tab, /^#3 .*\/popup2/);
  await pass({ type: "text_present", expected: "Popup Two" }, "on popup two");
  const selfClose = await call("qa_action", { action: "click", selector: "#closeme", step_description: "popup closes itself" });
  assert.equal(selfClose.json.status, "pass", selfClose.text);
  assert.equal((await call("qa_tab", { action: "list" })).json.tabs.length, 2);
  await pass({ type: "text_present", expected: "Fixture Form" }, "fell back to previous tab");

  const badIndex = await call("qa_tab", { action: "switch", index: 99 });
  assert.equal(badIndex.isError, true);
  assert.match(badIndex.json.error, /No tab #99/);
  assert.equal((await call("qa_tab", { action: "switch" })).isError, true);

  const fin = await call("qa_finish_session", {});
  const readme = readFileSync(fin.json.report, "utf8");
  assert.match(readme, /\*\*New tab:\*\* #2 /);
  assert.match(readme, /\*\*New tab:\*\* #3 /);
});

test("dialogs: dismissed by default, accept once/persist, prompt text, dialog_shown", { timeout: 90_000 }, async () => {
  await call("qa_start_session", { test_name: "dialogs" });
  await call("qa_navigate", { url: `${baseUrl}/dialogs`, step_description: "open dialogs page" });
  const click = (id) => call("qa_action", { action: "click", selector: id, step_description: `click ${id}` });
  const shows = async (expected) => {
    const r = await call("qa_assert", { type: "text_present", expected, step_description: `shows ${expected}` });
    assert.equal(r.json.status, "pass", r.text);
  };

  // Default: dismissed, but recorded and hinted
  const d1 = await click("#confirm");
  assert.deepEqual(d1.json.dialogs, ['confirm "Delete item?" -> dismissed']);
  assert.match(d1.json.hint, /qa_dialog action=accept/);
  await shows("kept");

  // accept applies to the next dialog only
  assert.equal((await call("qa_dialog", { action: "accept" })).json.status, "pass");
  const d2 = await click("#confirm");
  assert.deepEqual(d2.json.dialogs, ['confirm "Delete item?" -> accepted']);
  await shows("deleted");
  await click("#confirm");
  await shows("kept");

  // persist keeps it
  await call("qa_dialog", { action: "accept", persist: true });
  await click("#confirm");
  await shows("deleted");
  await call("qa_action", { action: "hover", selector: "h1", step_description: "reset marker" });
  await click("#confirm");
  await shows("deleted");

  // prompt with text and a placeholder
  await call("qa_dialog", { action: "accept", prompt_text: "Ana-{{rand}}" });
  const p = await click("#prompt");
  assert.deepEqual(p.json.dialogs, ['prompt "Your name?" -> accepted']);
  await shows("hi Ana-{{rand}}");

  // dialog_shown: alert message is not in the DOM, so this is the only way to verify it
  await call("qa_dialog", { action: "dismiss", persist: true });
  await click("#alert");
  const seen = await call("qa_assert", { type: "dialog_shown", expected: "Heads up", step_description: "alert shown" });
  assert.equal(seen.json.status, "pass", seen.text);
  assert.match(seen.json.detail, /alert "Heads up"/);
  const again = await call("qa_assert", { type: "dialog_shown", expected: "Heads up", step_description: "already consumed" });
  assert.equal(again.isError, true);
  const never = await call("qa_assert", { type: "dialog_shown", expected: "Never shown", step_description: "absent" });
  assert.equal(never.isError, true);
  assert.match(never.json.error, /No dialog containing "Never shown" appeared\. Unchecked dialogs: confirm/);

  const fin = await call("qa_finish_session", {});
  const readme = readFileSync(fin.json.report, "utf8");
  assert.match(readme, /\*\*Dialog:\*\* confirm "Delete item\?" -> dismissed/);
  assert.match(readme, /\*\*Dialog:\*\* confirm "Delete item\?" -> accepted/);
});
