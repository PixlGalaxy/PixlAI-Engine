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
