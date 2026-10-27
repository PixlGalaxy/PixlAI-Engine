import type { BrowserAction, BrowserElement, BrowserPage, BrowserPort } from '../ports.js';
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
