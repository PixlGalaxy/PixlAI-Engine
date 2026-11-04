import type { CodeLanguage, SandboxPort } from '../ports.js';
import { programRisk, siteOf } from '../browser/risk.js';
import { cleanPath } from './files.js';
import { defineTool, type ApprovalText, type GateContext, type Tool, type ToolContext } from './tool.js';

const LANGUAGES: CodeLanguage[] = ['python', 'node', 'shell'];
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 300;
/** Per stream; the rest is cut from the middle so the start and the error at the end both survive. */
const MAX_OUTPUT_CHARS = 8_000;
const MAX_CODE_CHARS = 100_000;

function sandboxOf(ctx: ToolContext): SandboxPort {
  if (!ctx.sandbox) throw new Error('Code execution is not available here');
  return ctx.sandbox;
}

/** Keeps the head and the tail of long output: tracebacks live at the end. */
export function clipMiddle(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  return `${text.slice(0, head)}\n[... ${text.length - max} characters cut ...]\n${text.slice(-tail)}`;
}

const MAX_BROWSER_SITES = 5;

type CodeArgs = { language: CodeLanguage; code: string; cwd?: string; timeout_s?: number; browser_sites?: string[] };

function sitesOf(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('browser_sites: the sites the program works on, e.g. ["reader.example.com"]');
  if (raw.length > MAX_BROWSER_SITES) throw new Error(`browser_sites: at most ${MAX_BROWSER_SITES} sites`);
  const sites = raw.map(siteOf);
  const bad = raw.find((_, i) => !sites[i]);
  if (bad !== undefined) throw new Error(`browser_sites: "${String(bad)}" is not a site name like "reader.example.com"`);
  return [...new Set(sites as string[])];
}

async function programReading(args: CodeArgs, ctx: GateContext) {
  const sites = sitesOf(args.browser_sites);
  const personal = ctx.personalData ? await ctx.personalData(ctx.user.id).catch(() => [] as string[]) : [];
  return { sites, risk: programRisk(String(args.code ?? ''), sites, personal) };
}

/**
 * A program that drives the browser holds the user's sign-ins for its sites: each site goes through the browser
 * policy (a blocked one refuses it), with the risk read from the code. Where nobody can approve, it counts as
 * sensitive whatever it does, so only sites the policy allows outright run it. Without browser_sites, code_run
 * runs as always.
 */
async function codeGate(args: CodeArgs, ctx: GateContext): Promise<'run' | 'approve' | { refuse: string }> {
  if (args.browser_sites === undefined) return 'run';
  if (!ctx.browser) return { refuse: 'A browser for programs is not available here: leave out browser_sites' };
  const { sites, risk } = await programReading(args, ctx);
  const nobody = ctx.runKind !== 'chat';
  const asked = nobody ? { level: 'sensitive' as const, reason: 'a program with nobody to approve it' } : risk;
  let approve = !ctx.browserPolicy;
  for (const site of sites) {
    const decision = ctx.browserPolicy ? await ctx.browserPolicy(ctx.user.id, `https://${site}/`, 'script', { element: null, risk: asked }) : 'approve';
    if (typeof decision === 'object') return { refuse: decision.block };
    if (decision !== 'allow') approve = true;
  }
  if (!approve) return 'run';
  return nobody ? { refuse: 'A program that uses the browser on these sites needs the user here; tell them what you would do instead' } : 'approve';
}

export const codeRun = defineTool<CodeArgs>({
  name: 'code_run',
  summary: 'run Python, Node.js or shell in the sandbox: math, data, charts, Word/Excel/PDF files, installing packages',
  description:
    "Run Python, Node.js or shell code in the user's sandbox. The working directory is their workspace (the same files as " +
    'the files_ tools), so scripts can read and write documents there: compute exactly, analyze CSV/Excel with pandas, ' +
    'make charts with matplotlib, convert or generate PDF/DOCX/PPTX/XLSX. Print what you need to see; save outputs as ' +
    'files and tell the user their paths. State is not kept between calls (write intermediate results to files). ' +
    'Numbers: let the code compute every result from the inputs (never type totals you worked out yourself), store ' +
    'them as numbers (spreadsheets: real values or formulas, not "$500" text), and print a check such as ' +
    'inputs - outputs = remaining before you report the results.',
  parameters: {
    type: 'object',
    properties: {
      language: { type: 'string', enum: LANGUAGES, description: 'Default: python' },
      code: { type: 'string', description: 'The whole program' },
      cwd: { type: 'string', description: 'Folder inside the workspace to run in (default: the root)' },
      timeout_s: { type: 'integer', description: `Seconds before it is stopped, 1-${MAX_TIMEOUT_S} (default ${DEFAULT_TIMEOUT_S})` },
      browser_sites: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Give the program a browser of its own to drive, signed in to these sites only (the student\'s sessions there, ' +
          'e.g. ["reader.example.com"]). Its address is in the environment variable STUDYHAWK_BROWSER: in Python, ' +
          'playwright.sync_api: `browser = p.chromium.connect_over_cdp(os.environ["STUDYHAWK_BROWSER"]); page = browser.contexts[0].new_page()`; ' +
          'in Node, require("playwright-core").chromium.connectOverCDP(...). Use it for long jobs across many pages (a whole ' +
          'book, page after page, even when each page loads anew), writing what it reads into files as it goes. It closes ' +
          'when the program ends. A tool reached from Canvas (McGraw Hill Connect, Pearson...) signs in through Canvas: open it ' +
          'first with canvas_tool_open, then declare its site (e.g. "mheducation.com") and the program gets that session. ' +
          'Programs that only open these sites, read, click through and save run freely; ones that ' +
          'use the network outside the browser, cookies, send forms, build code at run time, go to other sites or name ' +
          'buttons like Pay or Submit ask the student first. Never for signing in (school_sign_in) or Canvas.',
      },
    },
    required: ['code'],
  },
  sideEffect: 'none',
  timeoutMs: (MAX_TIMEOUT_S + 30) * 1000,
  gate: codeGate,
  async describe(args, ctx): Promise<ApprovalText> {
    const code = String(args.code ?? '');
    let sites: string[] = [];
    let why = 'runs code';
    try {
      const reading = await programReading(args, ctx);
      sites = reading.sites;
      why = reading.risk.reason;
    } catch {
      // Invalid sites: the run itself says so.
    }
    return {
      summary: `Run a program that uses your browser on ${sites.join(', ') || 'a site'}${why ? ` (${why})` : ''}`,
      details: { sites: sites.join(', '), why, code: code.length > 2000 ? `${code.slice(0, 2000)}\n...` : code },
    };
  },
  async run(args, ctx) {
    const sandbox = sandboxOf(ctx);
    // Models often leave it out for Python, the common case.
    const language = String(args.language ?? 'python') as CodeLanguage;
    if (!LANGUAGES.includes(language)) throw new Error(`language must be one of: ${LANGUAGES.join(', ')}`);
    const code = String(args.code ?? '');
    if (!code.trim()) throw new Error('code is empty');
    if (code.length > MAX_CODE_CHARS) throw new Error(`code is too long (max ${MAX_CODE_CHARS} characters); put data in files instead`);
    const cwd = args.cwd ? cleanPath(args.cwd) : '';
    const timeoutS = Math.min(MAX_TIMEOUT_S, Math.max(1, Number(args.timeout_s) || DEFAULT_TIMEOUT_S));
    const browser = args.browser_sites !== undefined ? { sites: sitesOf(args.browser_sites) } : undefined;
    const result = await sandbox.exec(ctx.user.id, { language, code, cwd, timeoutMs: timeoutS * 1000, ...(browser && { browser }) }, ctx.signal);
    return {
      exit_code: result.exitCode,
      ...(result.timedOut && { timed_out: `stopped after ${timeoutS}s` }),
      ...(result.exitCode === null && !result.timedOut && { killed: 'the process was killed (memory or process limit)' }),
      duration_s: Math.round(result.durationMs / 100) / 10,
      stdout: clipMiddle(result.stdout),
      stderr: clipMiddle(result.stderr),
      ...(result.files?.length && { files: result.files.slice(0, 50).map((f) => ({ path: f.path, size_kb: Math.round(f.size / 102.4) / 10 })) }),
    };
  },
});

export const CODE_TOOLS: Tool[] = [codeRun];
