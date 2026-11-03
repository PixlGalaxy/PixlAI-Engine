import type { BrowserAction, BrowserElement, BrowserPage, BrowserPort, PageTurn } from '../ports.js';
import { ragAdd, ragCreate } from '../rag/tools.js';
import { ragId, UserRags } from '../rag/store.js';
import { assertNotRag, assertVisible, cleanPath, workspaceOf } from '../tools/files.js';
import { defineTool, type ApprovalText, type GateContext, type Tool, type ToolContext } from '../tools/tool.js';

/** Snapshot characters sent to the model per page view. */
const SNAPSHOT_CHARS = 12_000;
const PROFILE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const BROWSER_TIMEOUT_MS = 90_000;

function browserOf(ctx: Pick<ToolContext, 'browser'>): BrowserPort {
  if (!ctx.browser) throw new Error('The browser is not available here');
  return ctx.browser;
}

function profileOf(raw: unknown): string {
  const profile = String(raw ?? 'default').trim().toLowerCase() || 'default';
  if (!PROFILE.test(profile)) throw new Error('profile: lowercase letters, digits, - and _ (e.g. "default", "outlook")');
  return profile;
}

function view(page: BrowserPage) {
  const clipped = page.snapshot.length > SNAPSHOT_CHARS;
  return {
    url: page.url,
    title: page.title,
    snapshot: clipped ? `${page.snapshot.slice(0, SNAPSHOT_CHARS)}\n[... page continues: scroll down and snapshot again ...]` : page.snapshot,
  };
}

/**
 * Acting on a page (click, type, keys) is checked against the host's policy
 * for the page it would happen on. Without a policy every action needs the
 * user's approval: a click can submit, buy or delete.
 */
function actionGate(kind: BrowserAction['kind']) {
  return async (args: { profile?: string }, ctx: GateContext): Promise<'run' | 'approve' | { refuse: string }> => {
    const url = await browserOf(ctx).currentUrl(ctx.user.id, profileOf(args.profile));
    if (!url) return { refuse: 'No page is open in this profile: use browser_open first' };
    if (ctx.runKind !== 'chat') {
      // Nobody is there to approve in scheduled runs and subagents: only what the policy allows outright.
      const decision = ctx.browserPolicy ? await ctx.browserPolicy(ctx.user.id, url, kind) : 'approve';
      return decision === 'allow' ? 'run' : { refuse: 'Acting on pages needs the user here; tell them what you would do instead' };
    }
    if (!ctx.browserPolicy) return 'approve';
    const decision = await ctx.browserPolicy(ctx.user.id, url, kind);
    if (typeof decision === 'object') return { refuse: decision.block };
    return decision === 'allow' ? 'run' : 'approve';
  };
}

/** The page as an approval shows it: host and path, short. */
function pageOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const where = `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
    return where.length > 80 ? `${where.slice(0, 80)}...` : where;
  } catch {
    return null;
  }
}

/**
 * What an approval shows about an action on the open page: which page, what the ref is ("Sign in", a
 * button) and a picture of the page with it outlined, so the user approves what they can see, not "@e7".
 * Every part is optional: a host without element() or a failed picture still gets an approval.
 */
async function target(ctx: GateContext, profileRaw: unknown, ref?: string): Promise<{ page: string | null; element: BrowserElement | null; image?: string }> {
  const browser = ctx.browser;
  if (!browser) return { page: null, element: null };
  const profile = profileOf(profileRaw);
  const [url, element] = await Promise.all([
    browser.currentUrl(ctx.user.id, profile).catch(() => null),
    ref && browser.element ? browser.element(ctx.user.id, profile, ref).catch(() => null) : Promise.resolve(null),
  ]);
  const shot = await browser
    .screenshot(ctx.user.id, profile, AbortSignal.timeout(20_000), { jpeg: true, ...(ref && element && { highlight: ref }) })
    .catch(() => null);
  return { page: pageOf(url), element, ...(shot && { image: shot.path }) };
}

const named = (element: BrowserElement | null, ref: string) =>
  element ? (element.label ? `"${element.label}" (${element.role})` : `a ${element.role}`) : ref;
const on = (page: string | null) => (page ? ` on ${page.split('/')[0]}` : '');

const profileParam = { type: 'string', description: 'Cookie profile: "default", or a name to keep a login apart (e.g. "outlook")' };
const refParam = { type: 'string', description: 'Element ref from the latest snapshot, e.g. "@e12"' };

export const browserOpen = defineTool<{ url: string; profile?: string }>({
  name: 'browser_open',
  summary: 'open a site in a real browser (stays signed in, clicks and types like a person)',
  description:
    "Open a URL in the user's own browser (a real Chromium that keeps cookies, so sites they logged into stay logged in). " +
    'Returns a snapshot of the page: text and interactive elements with refs like [@e12] for browser_click/browser_type. ' +
    'Prefer web_fetch for plain public pages; use the browser for logins, JavaScript apps and multi-step flows.',
  parameters: { type: 'object', properties: { url: { type: 'string' }, profile: profileParam }, required: ['url'] },
  sideEffect: 'none',
  untrusted: true,
  mainAgentOnly: true,
  timeoutMs: BROWSER_TIMEOUT_MS,
  async run(args, ctx) {
    let url: URL;
    try {
      url = new URL(String(args.url ?? '').trim());
    } catch {
      throw new Error('Give a full URL starting with http:// or https://');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https URLs can be opened');
    return view(await browserOf(ctx).open(ctx.user.id, profileOf(args.profile), url.toString(), ctx.signal));
  },
});

export const browserSnapshot = defineTool<{ profile?: string }>({
  name: 'browser_snapshot',
  summary: 'read the open page again',
  description: 'Read the page that is open now again (after it changed, or after scrolling).',
  parameters: { type: 'object', properties: { profile: profileParam } },
  sideEffect: 'none',
  untrusted: true,
  mainAgentOnly: true,
  timeoutMs: BROWSER_TIMEOUT_MS,
  async run(args, ctx) {
    return view(await browserOf(ctx).snapshot(ctx.user.id, profileOf(args.profile), ctx.signal));
  },
});

export const browserClick = defineTool<{ ref: string; profile?: string }>({
  name: 'browser_click',
  summary: 'click something on the open page',
  description: 'Click an element of the open page by its ref. May need the user\'s approval depending on the site.',
  parameters: { type: 'object', properties: { ref: refParam, profile: profileParam }, required: ['ref'] },
  sideEffect: 'none',
  untrusted: true,
  mainAgentOnly: true,
  timeoutMs: BROWSER_TIMEOUT_MS,
  gate: actionGate('click'),
  async describe(a, ctx): Promise<ApprovalText> {
    const ref = String(a.ref);
    const { page, element, image } = await target(ctx, a.profile, ref);
    return {
      summary: `Click ${named(element, ref)}${on(page)}`,
      details: { ...(page && { page }), element: element ? `${element.role} "${element.label}"` : ref },
      ...(image && { image }),
    };
  },
  async run(args, ctx) {
    return view(await browserOf(ctx).act(ctx.user.id, profileOf(args.profile), { kind: 'click', ref: String(args.ref) }, ctx.signal));
  },
});

export const browserType = defineTool<{ ref: string; text: string; submit?: boolean; profile?: string }>({
  name: 'browser_type',
  summary: 'type into a field on the open page',
  description: 'Type text into a field of the open page (replacing what it had). submit: press Enter after typing.',
  parameters: {
    type: 'object',
    properties: { ref: refParam, text: { type: 'string' }, submit: { type: 'boolean' }, profile: profileParam },
    required: ['ref', 'text'],
  },
  sideEffect: 'none',
  untrusted: true,
  mainAgentOnly: true,
  timeoutMs: BROWSER_TIMEOUT_MS,
  gate: actionGate('type'),
  async describe(a, ctx): Promise<ApprovalText> {
    const ref = String(a.ref);
    const { page, element, image } = await target(ctx, a.profile, ref);
    const text = String(a.text ?? '');
    return {
      summary: `Type into ${named(element, ref)}${a.submit ? ' and press Enter' : ''}${on(page)}`,
      details: {
        ...(page && { page }),
        field: element ? `${element.role} "${element.label}"` : ref,
        // A password is never shown back, not even to its owner on screen.
        text: element?.password ? '•'.repeat(Math.min(text.length, 12)) : text.slice(0, 200),
      },
      ...(image && { image }),
    };
  },
  async run(args, ctx) {
    const action: BrowserAction = { kind: 'type', ref: String(args.ref), text: String(args.text ?? ''), submit: Boolean(args.submit) };
    return view(await browserOf(ctx).act(ctx.user.id, profileOf(args.profile), action, ctx.signal));
  },
});

export const browserPress = defineTool<{ key: string; profile?: string }>({
  name: 'browser_press',
  summary: 'press a key on the open page',
  description: 'Press a key on the open page, e.g. "Enter", "Escape", "Tab", "ArrowDown".',
  parameters: { type: 'object', properties: { key: { type: 'string' }, profile: profileParam }, required: ['key'] },
  sideEffect: 'none',
  untrusted: true,
  mainAgentOnly: true,
  timeoutMs: BROWSER_TIMEOUT_MS,
  gate: actionGate('press'),
  async describe(a, ctx): Promise<ApprovalText> {
    const { page, image } = await target(ctx, a.profile);
    return { summary: `Press ${a.key}${on(page) || ' in the browser'}`, details: { ...(page && { page }), key: String(a.key) }, ...(image && { image }) };
  },
  async run(args, ctx) {
    const key = String(args.key ?? '').trim();
    if (!/^[A-Za-z0-9+]{1,30}$/.test(key)) throw new Error('key: a key name like "Enter" or "Control+A"');
    return view(await browserOf(ctx).act(ctx.user.id, profileOf(args.profile), { kind: 'press', key }, ctx.signal));
  },
});

export const browserScroll = defineTool<{ direction: 'up' | 'down'; profile?: string }>({
  name: 'browser_scroll',
  summary: 'scroll the open page',
  description: 'Scroll the open page one screen up or down and return the new snapshot.',
  parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'] }, profile: profileParam }, required: ['direction'] },
  sideEffect: 'none',
  untrusted: true,
  mainAgentOnly: true,
  timeoutMs: BROWSER_TIMEOUT_MS,
  async run(args, ctx) {
    const direction = args.direction === 'up' ? 'up' : 'down';
    return view(await browserOf(ctx).act(ctx.user.id, profileOf(args.profile), { kind: 'scroll', direction }, ctx.signal));
  },
});

export const browserBack = defineTool<{ profile?: string }>({
  name: 'browser_back',
  summary: 'go back a page',
  description: 'Go back to the previous page.',
  parameters: { type: 'object', properties: { profile: profileParam } },
  sideEffect: 'none',
  untrusted: true,
  mainAgentOnly: true,
  timeoutMs: BROWSER_TIMEOUT_MS,
  async run(args, ctx) {
    return view(await browserOf(ctx).act(ctx.user.id, profileOf(args.profile), { kind: 'back' }, ctx.signal));
  },
});

export const browserScreenshot = defineTool<{ profile?: string }>({
  name: 'browser_screenshot',
  summary: 'save a picture of the open page',
  description: "Save a picture of the open page into the user's files (to show them what you see, or keep evidence).",
  parameters: { type: 'object', properties: { profile: profileParam } },
  sideEffect: 'none',
  mainAgentOnly: true,
  timeoutMs: BROWSER_TIMEOUT_MS,
  async run(args, ctx) {
    return browserOf(ctx).screenshot(ctx.user.id, profileOf(args.profile), ctx.signal);
  },
});

export const browserClose = defineTool<{ profile?: string }>({
  name: 'browser_close',
  summary: 'close the browser when done',
  description: 'Close the browser for this profile when you are done (cookies are kept for next time).',
  parameters: { type: 'object', properties: { profile: profileParam } },
  sideEffect: 'none',
  mainAgentOnly: true,
  async run(args, ctx) {
    await browserOf(ctx).close(ctx.user.id, profileOf(args.profile));
    return { closed: true };
  },
});

/** browser_save_pages: pages per batch, the most per call, and when it stops to answer before its timeout. */
const SAVE_BATCH = 20;
const SAVE_DEFAULT_PAGES = 500;
const SAVE_MAX_PAGES = 2000;
const SAVE_MAX_BYTES = 20 * 1024 * 1024;
const SAVE_BUDGET_MS = 25 * 60_000;
const SAVE_TIMEOUT_MS = 45 * 60_000;
const TURN_KEYS = ['ArrowRight', 'ArrowDown', 'PageDown', 'Space'];

type SaveArgs = { path: string; turn?: string; ref?: string; key?: string; max_pages?: number; rag?: string; profile?: string };

function turnOf(args: SaveArgs): PageTurn {
  const kind = String(args.turn ?? 'none');
  if (kind === 'none' || kind === 'scroll') return { kind };
  if (kind === 'click') {
    const ref = String(args.ref ?? '').trim();
    if (!/^@?e\d{1,6}$/.test(ref)) throw new Error('turn "click" needs ref: the "next page" control from the latest snapshot, e.g. "@e12"');
    return { kind, ref };
  }
  if (kind === 'press') {
    const key = String(args.key ?? 'ArrowRight');
    if (!TURN_KEYS.includes(key)) throw new Error(`key: one of ${TURN_KEYS.join(', ')}`);
    return { kind, key };
  }
  throw new Error('turn: none, click, press or scroll');
}

function savePathOf(raw: unknown): string {
  let path = cleanPath(raw);
  if (!path) throw new Error('path is required, e.g. "Books/Financial Accounting.md"');
  if (!/\.md$/i.test(path)) path = `${path}.md`;
  assertNotRag(path);
  return path;
}

const pagesOf = (raw: unknown) => Math.min(Math.max(Math.floor(Number(raw) || SAVE_DEFAULT_PAGES), 1), SAVE_MAX_PAGES);

export const browserSavePages = defineTool<SaveArgs>({
  name: 'browser_save_pages',
  summary: 'save a long text read in the browser (an online book with no download) as Markdown, and index it',
  description:
    'Save the text of the page open in the browser into a Markdown file, going on page after page, so a long text the ' +
    'student can only read online (an e-book reader, a chapter split into pages, a long article) can be kept and searched ' +
    'when there is no download. The text goes straight to the file, not into the conversation. Open the first page you ' +
    'want first (browser_open, signing in if needed) and take a snapshot to find how to reach the next page. turn: ' +
    '"click" a "Next page" control (ref from the snapshot), "press" a key (ArrowRight, ArrowDown, PageDown, Space), ' +
    '"scroll" down a long page, or "none" for only the page that is open. It stops at the last page (nothing changes, or ' +
    'Next is gone or disabled), or at max_pages (default 500). rag: a collection (created if missing) the file is added to ' +
    'when the reading ends, so you can answer from it with rag_ask. A reader that shows its pages as pictures has no text ' +
    'to save: say so instead of retrying. Only for the student\'s own study: the file stays in their files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Markdown file to write, e.g. "Books/Financial Accounting.md" (replaced if it exists)' },
      turn: { type: 'string', enum: ['click', 'press', 'scroll', 'none'] },
      ref: { type: 'string', description: 'With turn "click": the next page control, e.g. "@e12"' },
      key: { type: 'string', enum: TURN_KEYS, description: 'With turn "press" (default ArrowRight)' },
      max_pages: { type: 'number', description: `Most pages to read (default ${SAVE_DEFAULT_PAGES}, at most ${SAVE_MAX_PAGES})` },
      rag: { type: 'string', description: 'Collection to add the file to when done, e.g. "ACG 2021 textbook" (created if missing)' },
      profile: profileParam,
    },
    required: ['path'],
  },
  sideEffect: 'none',
  untrusted: true,
  mainAgentOnly: true,
  timeoutMs: SAVE_TIMEOUT_MS,
  // Turning pages clicks or presses keys on the site: one approval for the whole reading, as the site's policy says.
  // Reading what is open, or scrolling, acts on nothing.
  async gate(args, ctx) {
    const kind = String(args.turn ?? 'none');
    if (kind === 'click' || kind === 'press') return actionGate(kind)(args, ctx);
    return (await browserOf(ctx).currentUrl(ctx.user.id, profileOf(args.profile))) ? 'run' : { refuse: 'No page is open in this profile: use browser_open first' };
  },
  async describe(args, ctx): Promise<ApprovalText> {
    const ref = args.turn === 'click' ? String(args.ref ?? '') : undefined;
    const { page, element, image } = await target(ctx, args.profile, ref);
    const how = args.turn === 'click' ? `clicking ${named(element, ref ?? '')}` : `pressing ${String(args.key ?? 'ArrowRight')}`;
    let path: string;
    try {
      path = savePathOf(args.path);
    } catch {
      path = String(args.path ?? '');
    }
    return {
      summary: `Read up to ${pagesOf(args.max_pages)} pages${on(page)}, ${how} to turn each page, and save them`,
      details: { ...(page && { page }), turn: how, file: path, ...(args.rag && { rag: String(args.rag) }) },
      ...(image && { image }),
    };
  },
  async run(args, ctx) {
    const browser = browserOf(ctx);
    if (!browser.readPages) throw new Error('Saving pages is not available in this browser');
    const ws = workspaceOf(ctx);
    const profile = profileOf(args.profile);
    const turn = turnOf(args);
    const path = savePathOf(args.path);
    assertVisible(ws, path);
    const max = pagesOf(args.max_pages);
    if (args.rag && !ctx.embeddings) throw new Error('RAG is not available here (no embedding model): leave out rag');

    const started = Date.now();
    let pages = 0;
    let bytes = 0;
    let end: string | null = null;
    let first = true;
    // A batch can end with nothing new (a long page scrolled through for a while): a few in a row is the end.
    let empty = 0;
    let source = { url: '', title: '' };
    while (pages < max) {
      const batch = await browser.readPages(ctx.user.id, profile, { start: first, turn, pages: Math.min(SAVE_BATCH, max - pages) }, ctx.signal);
      if (first) {
        if (batch.end === 'no-text' && !batch.markdown) {
          throw new Error(
            batch.images
              ? 'This reader shows its pages as pictures (images or a canvas), so there is no text to save. Tell the student; do not retry.'
              : 'There is no text to read on this page. Check that the book itself is open (not a cover or a menu), or tell the student.',
          );
        }
        source = { url: batch.url, title: batch.title };
        const head = `# ${batch.title || 'Saved pages'}\n\nSource: ${batch.url}\nSaved: ${ctx.clock.now().toISOString().slice(0, 10)}\n\n`;
        await ws.write(ctx.user.id, path, head);
        bytes += Buffer.byteLength(head);
        first = false;
      }
      if (batch.markdown) {
        const text = `${batch.markdown}\n\n`;
        await ws.write(ctx.user.id, path, text, { append: true });
        bytes += Buffer.byteLength(text);
      }
      pages += batch.pages;
      end = batch.end;
      empty = batch.pages === 0 ? empty + 1 : 0;
      if (end || empty >= 3) break;
      if (bytes > SAVE_MAX_BYTES || Date.now() - started > SAVE_BUDGET_MS) break;
    }
    const complete = end !== null || pages >= max;
    const result: Record<string, unknown> = {
      saved: path,
      title: source.title,
      url: source.url,
      pages,
      characters: bytes,
      stopped: end === 'last-page' ? 'last page reached' : end === 'done' ? 'only the open page was asked' : pages >= max ? 'max_pages reached' : 'time or size limit',
      ...(!complete && { note: 'Not finished: the browser is on the last page read. Call again with turn and a new path (e.g. "... part 2.md") to go on.' }),
    };
    if (args.rag) {
      const name = String(args.rag).trim();
      const rags = new UserRags(ws, ctx.user.id);
      if (!(await rags.exists(ragId(name)))) {
        // Not the page's title: it is the site's text, and rag_list shows descriptions to the agent as they are.
        await ragCreate.run({ name, description: `Pages saved from ${source.url ? new URL(source.url).host : 'the browser'} into ${path}` }, ctx);
      }
      result.rag = { rag: ragId(name), ...((await ragAdd.run({ rag: ragId(name), paths: [path] }, ctx)) as Record<string, unknown>) };
    }
    return result;
  },
});

export const BROWSER_TOOLS: Tool[] = [
  browserOpen,
  browserSnapshot,
  browserClick,
  browserType,
  browserPress,
  browserScroll,
  browserBack,
  browserScreenshot,
  browserClose,
];
