import type { ActionRisk, BrowserAction, BrowserElement } from '../ports.js';
import type { GateContext } from '../tools/tool.js';

/**
 * Buttons whose name says the click commits something (English and Spanish): signing in or up, sending,
 * publishing, paying, deleting, agreeing. Whole words, so "Postpone" or "Sending options" stay routine only
 * when they really are a different word.
 */
const COMMITS = new RegExp(
  '\\b(' +
    [
      'send', 'submit', 'post', 'publish', 'reply', 'share', 'pay', 'purchase', 'buy', 'order', 'place order', 'checkout', 'check out',
      'donate', 'subscribe', 'unsubscribe', 'delete', 'remove', 'erase', 'cancel', 'withdraw', 'drop', 'transfer', 'accept', 'agree',
      'allow', 'authorize', 'grant', 'confirm', 'sign ?up', 'register', 'enroll', 'apply', 'upload', 'log ?in', 'sign ?in', 'save changes',
      'book', 'reserve',
      'enviar', 'publicar', 'responder', 'compartir', 'pagar', 'comprar', 'donar', 'suscribirse', 'eliminar', 'borrar', 'cancelar',
      'retirar', 'transferir', 'aceptar', 'autorizar', 'confirmar', 'registrarse', 'inscribirse', 'aplicar', 'subir', 'iniciar sesi[oó]n',
      'entrar', 'guardar cambios', 'reservar',
    ].join('|') +
    ')\\b',
  'i',
);

const sensitive = (reason: string): ActionRisk => ({ level: 'sensitive', reason });
const routine = (reason: string): ActionRisk => ({ level: 'routine', reason });

/** Sending this form would send something that matters (not a search box). */
const sendsForm = (element: BrowserElement) => Boolean(element.form && !element.form.search);

/**
 * How risky a browser action is, from what is acted on. Routine: reading, navigating (links, menus, tabs,
 * "Next"), scrolling, typing into ordinary fields, keys that send nothing, and searching. Sensitive: typing
 * a password or payment details, sending a form (a click on its submit button, or Enter in it), and buttons
 * whose name commits something (Send, Pay, Delete, Sign in, Accept...). An element the host cannot describe
 * counts as sensitive.
 */
export function browserActionRisk(action: BrowserAction, element: BrowserElement | null): ActionRisk {
  if (action.kind === 'scroll' || action.kind === 'back') return routine('navigation');
  if (action.kind === 'press') {
    if (!/enter/i.test(action.key)) return routine('a key that sends nothing');
    if (!element) return sensitive('Enter on an element that could not be read');
    if (element.form?.search) return routine('a search');
    if (element.form && (element.submits ?? true)) return sensitive('Enter sends the form');
    return routine('Enter outside a form');
  }
  if (!element) return sensitive('an element that could not be read');
  if (action.kind === 'type') {
    if (element.password || element.field === 'password') return sensitive('a password field');
    if (element.field === 'payment') return sensitive('a payment field');
    if (action.submit && sendsForm(element)) return sensitive('typing and sending the form');
    return routine('filling in a field');
  }
  // A click.
  if (COMMITS.test(element.label)) return sensitive(`"${element.label.slice(0, 40)}" commits something`);
  if (element.submits && sendsForm(element)) return sensitive('sends the form');
  if (element.submits && element.form?.search) return routine('a search');
  if (element.link || element.role === 'link') return routine('a link');
  // A host that does not say whether a button sends its form (submits left out): it might.
  if (element.submits === undefined) return sensitive('a button that may send a form');
  return routine('a click that sends nothing');
}

/**
 * A button named in code ('Pay', "Submit"...) whose click may commit something: literals that read like a
 * button's name, and in CSS selectors (".book-page") only the names they quote ([aria-label='Pay now'],
 * :has-text("Submit")). The reason, or null.
 */
function namedCommit(code: string): string | null {
  for (const literal of code.match(/(['"`])(?:\\.|(?!\1).){1,80}\1/g) ?? []) {
    const words = literal.slice(1, -1);
    const names = /[.#[\]=>:/]/.test(words) ? [...words.matchAll(/(?:=\s*|text\(\s*|contains\(\s*|name=)['"]?([^'"\])]+)/g)].map((m) => m[1]!) : [words];
    const hit = names.find((name) => COMMITS.test(name));
    if (hit) return `names "${hit.slice(0, 40)}"`;
  }
  return null;
}

/**
 * What a script the agent wrote would do that matters (browser_run_js), from reading its code: talking to
 * the network, reading cookies or stored data, sending forms, navigating away with data, hiding what it does,
 * naming a button that commits something, touching password or payment fields, or carrying the user's data.
 * Code that only reads the page, clicks through it and returns what it found is routine. Reading code cannot
 * be perfect (that is why it errs on the side of asking): a script that clicks a button found by position is
 * not caught.
 */
export function scriptRisk(code: string, personal: string[] = []): ActionRisk {
  const checks: [RegExp, string][] = [
    [/\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|RTCPeerConnection|importScripts)\b|\bimport\s*\(/, 'talks to the network'],
    [/\bnew\s+Image\b|\.src\s*=(?!=)|\bsetAttribute\s*\(\s*['"`](src|href|action)['"`]/, 'loads a URL (which can carry data out)'],
    [/document\.cookie|\b(localStorage|sessionStorage|indexedDB|caches|navigator\.credentials)\b/, 'reads cookies or stored data'],
    [/\.(submit|requestSubmit)\s*\(|new\s+SubmitEvent/, 'sends a form'],
    [/\b(location|window\.location|document\.location)\s*(\.href\s*)?=(?!=)|location\.(assign|replace)\s*\(|window\.open\s*\(|\.href\s*=(?!=)/, 'navigates (a URL can carry data out)'],
    // Names built at run time (window["fe" + "tch"], document["coo" + "kie"]) hide what is called.
    [/\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(|\batob\s*\(|\b(window|globalThis|self|top|parent|document|navigator)\s*\[|String\.fromCharCode|\bReflect\.|\bProxy\b/, 'hides what it does'],
    [/\b(top|parent|opener)\s*\./, 'reaches other windows'],
    [/type\s*=\s*['"]?password|\bpassword\b|autocomplete\s*[*^$]?=\s*['"]?cc-|card.?number|\bcvv\b|\bcvc\b/i, 'touches a password or payment field'],
  ];
  for (const [pattern, reason] of checks) if (pattern.test(code)) return sensitive(reason);
  // A button named in the code ('Pay', "Submit"...): the click it is there for may commit something.
  const named = namedCommit(code);
  if (named) return sensitive(named);
  const found = findPersonalData(code, personal);
  if (found) return sensitive(`carries the user's ${found}`);
  return routine('reads and moves through the page');
}

/** A site a program declares (browser_sites): a host name, without scheme, path or "www.". Null when it is not one. */
export function siteOf(raw: unknown): string | null {
  const text = String(raw ?? '').trim().toLowerCase();
  let host = text;
  try {
    host = new URL(/^[a-z]+:\/\//.test(text) ? text : `https://${text}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && host.length <= 253 ? host : null;
}

const onSite = (host: string, sites: string[]) => sites.some((site) => host === site || host.endsWith(`.${site}`));

/**
 * What a program that drives the browser would do that matters (code_run with browser_sites), from reading its
 * code, in any language: talking to the network outside the browser (where the pages' text could go), cookies
 * and stored sign-ins, sending forms, running code it builds at run time, going to a site it did not declare,
 * password or payment fields, buttons that commit something, the user's personal data. A program that opens the
 * declared sites, reads them, clicks through and saves what it found into files is routine. Like scriptRisk, a
 * reading of code: it errs on the side of asking.
 */
export function programRisk(code: string, sites: string[], personal: string[] = []): ActionRisk {
  const checks: [RegExp, string][] = [
    [/\b(requests|urllib|httpx|aiohttp|http\.client|socket|smtplib|ftplib|curl|wget|nc|fetch|XMLHttpRequest|sendBeacon|WebSocket)\b|\.request\.(get|post|put|fetch|delete)\b|\bnew_request\b|\brequest\.new_context\b/, 'talks to the network outside the browser'],
    [/\b(cookies|add_cookies|clear_cookies|storage_state|addCookies|storageState)\b|document\.cookie|\b(localStorage|sessionStorage|indexedDB)\b/, 'reads or changes cookies or stored sign-ins'],
    [/\.(submit|requestSubmit)\s*\(|press\s*\(\s*['"`][^'"`]*Enter/, 'sends a form'],
    [/\beval\s*\(|\bexec\s*\(|\b__import__\b|\bgetattr\s*\(|\bcompile\s*\(|\bbase64\b|\batob\s*\(|\bnew\s+Function\b|\bimportlib\b|\bsubprocess\b|\bos\.system\b|child_process/, 'runs code it builds or other programs'],
    [/type\s*=\s*['"]?password|\bpassword\b|autocomplete\s*[*^$]?=\s*['"]?cc-|card.?number|\bcvv\b|\bcvc\b/i, 'touches a password or payment field'],
  ];
  for (const [pattern, reason] of checks) if (pattern.test(code)) return sensitive(reason);
  // Every address it names must be on a declared site.
  for (const url of code.match(/https?:\/\/[^\s'"`)<>]+/gi) ?? []) {
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return sensitive('names an address that cannot be read');
    }
    if (!onSite(host, sites) && host !== '127.0.0.1' && host !== 'localhost') return sensitive(`goes to ${host}, which it did not declare`);
  }
  const named = namedCommit(code);
  if (named) return sensitive(named);
  const found = findPersonalData(code, personal);
  if (found) return sensitive(`carries the user's ${found}`);
  return routine('reads the declared sites');
}

/** The approval's view of what sending the form would send (passwords already come as dots). */
export function formSummary(element: BrowserElement | null): string | null {
  const fields = element?.form?.fields ?? [];
  if (!fields.length) return null;
  return fields
    .slice(0, 8)
    .map((f) => `${f.label || 'field'}: ${f.value.length > 80 ? `${f.value.slice(0, 80)}...` : f.value}`)
    .join('\n');
}

/** What kind of personal value it is, for the approval (never the value itself in a refusal). */
const kindOf = (value: string) => (value.includes('@') ? 'email address' : /^[a-z]{0,3}\d{5,}$/i.test(value) ? 'ID number' : /\s/.test(value) ? 'full name' : 'username');

function encodings(value: string): string[] {
  const out = [value.toLowerCase(), encodeURIComponent(value).toLowerCase()];
  const b64 = Buffer.from(value, 'utf8').toString('base64').replace(/=+$/, '');
  out.push(b64, b64.replace(/\+/g, '-').replace(/\//g, '_'));
  return out;
}

/**
 * Which of the user's personal values `text` (a URL, a search query) carries, as a kind ("email address"),
 * or null. Looks at the text as it is, URL-decoded, and for each value also its URL-encoded and base64 forms.
 */
export function findPersonalData(text: string, values: string[]): string | null {
  let decoded = text;
  try {
    decoded = decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    // Not valid percent-encoding: the text as it is.
  }
  const haystacks = [text, text.toLowerCase(), decoded.toLowerCase()];
  for (const raw of values) {
    const value = String(raw ?? '').trim();
    if (value.length < 4) continue;
    if (encodings(value).some((needle) => haystacks.some((h) => h.includes(needle)))) return kindOf(value);
  }
  return null;
}

/**
 * A gate for tools that send something to a third party (opening a URL, a search): when it carries the
 * user's personal data, as a page's hidden instructions could ask for, the user approves it first. Nobody
 * can approve in scheduled runs and subagents, so there it is refused.
 */
export async function personalDataGate(ctx: GateContext, text: string, what: string): Promise<'run' | 'approve' | { refuse: string }> {
  if (!ctx.personalData) return 'run';
  const values = await ctx.personalData(ctx.user.id).catch(() => [] as string[]);
  const found = findPersonalData(text, values);
  if (!found) return 'run';
  if (ctx.runKind === 'chat') return 'approve';
  return { refuse: `This ${what} carries the user's ${found}: sending it needs their approval, and they are not here. Do it without it, or ask them later.` };
}

/** The approval line for such a call: where it goes and what of theirs it carries. */
export async function personalDataNote(ctx: GateContext, text: string): Promise<string | null> {
  if (!ctx.personalData) return null;
  return findPersonalData(text, await ctx.personalData(ctx.user.id).catch(() => [] as string[]));
}
