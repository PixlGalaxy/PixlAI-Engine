# Code, web and browser

Three optional packs give the agent hands outside the conversation. Each one
appears only when you pass the port it needs:

| Pack | Option | Tools |
|---|---|---|
| code | `sandbox: SandboxPort` | `code_run` |
| web | `search: SearchPort` | `web_search` |
| | `fetcher: FetchPort` | `web_fetch`, and with a `workspace` also `web_download` |
| browser | `browser: BrowserPort` (+ optional `browserPolicy`) | `browser_open`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_back`, `browser_screenshot`, `browser_close` |
| | `browser.readPages` + `workspace` | `browser_save_pages` ([below](#saving-a-long-text-browser_save_pages)) |

```ts
const engine = createEngine({
  stores,
  basePrompt,
  workspace,                 // the files code_run and web_download work with
  sandbox: mySandbox,        // runs code where the workspace is the working tree
  search: mySearch,          // SearXNG, Brave, Google CSE...
  fetcher: myFetcher,        // downloads public URLs safely (SSRF rules are yours)
  browser: myBrowser,        // a real Chromium per user (Playwright...)
  browserPolicy: myPolicy,   // which clicks run, ask or are blocked
});
```

## SandboxPort and `code_run`

```ts
interface SandboxPort {
  describe(userId: string): Promise<string>;
  exec(userId: string, request: ExecRequest, signal: AbortSignal): Promise<ExecResult>;
}
interface ExecRequest { language: 'python' | 'node' | 'shell'; code: string; cwd: string; timeoutMs: number }
interface ExecResult { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number; files?: { path: string; size: number }[] }
```

- The working directory is the user's workspace: `cwd` is relative to it (already checked for `..`). The same files the
  files pack and `WorkspacePort` see, so the agent can download a CSV with `web_download`, analyze it with `code_run`
  and the user downloads the chart from their files.
- `describe` goes into the system prompt under `## Code sandbox` whenever `code_run` is offered. It must be cheap (answer
  from config, do not start a container): say what is installed and what is not allowed, e.g. "Python 3.12 with pandas,
  matplotlib, openpyxl; no network".
- Isolation, CPU/memory limits and the network policy are entirely the host's job. Return `exitCode: null` when the
  process was killed and `timedOut: true` when your timeout fired.
- `code_run` accepts a timeout of 1 to 300 seconds (default 60), keeps the head and the tail of long output (8,000
  characters per stream; tracebacks are at the end) and lists up to 50 `files` the run created or changed.
- It is not main-agent-only: subagents can run code in parallel. Calls are stateless; tell the model (the description
  does) to keep intermediate results in files.

## SearchPort, FetchPort and the web pack

```ts
interface SearchPort {
  // userId: who searches, for providers that act per user (e.g. their own browser)
  search(query: string, options: { limit: number; language?: string; signal: AbortSignal; userId?: string }): Promise<SearchHit[]>;
}
interface FetchPort {
  fetch(url: string, options: { maxBytes: number; signal: AbortSignal }): Promise<FetchedPage>;
}
interface FetchedPage { url: string; status: number; contentType: string; body: Buffer }
```

- `web_search`: up to 10 results with title, URL and snippet. Results are untrusted content.
- `web_fetch`: reads a URL as text. HTML goes through `htmlToText` (exported): it keeps headings, paragraphs, lists,
  table rows and links as Markdown, drops scripts, styles, navigation, footers, forms and elements with `hidden` or
  `aria-hidden="true"`, and prefers the page's `<main>`/`<article>`. Documents (PDF, DOCX...) go through your
  `TextExtractor`, with a `page` argument. Long content comes in parts of 15,000 characters with `next_offset`. Up to
  10 MB. Results are untrusted content. When a `BrowserPort` is configured, `web_fetch` reads two kinds of page in
  the real browser instead (profile `reader`, closed afterwards) and says `read_with: "browser"`: HTML with under 300
  characters of text (drawn by JavaScript) and answers 403, 429 or 503 (bot checks).
- `web_download`: saves the file into the workspace (default `TEMP/web/`), up to 100 MB, for `files_read`, `rag_add` or
  `code_run`.
- **Your `FetchPort` is the security boundary.** Refuse private and loopback addresses (also after DNS resolution and
  on every redirect), cap the size, and set a timeout. The tools only accept `http:` and `https:` URLs.

### Several search providers: `SearchChain`

One search service gets blocked or rate limited sooner or later. `SearchChain` is a `SearchPort` that tries
providers in order and returns the first results:

```ts
const search = new SearchChain([
  { name: 'searxng', search: searx.search.bind(searx) },
  { name: 'duckduckgo', search: ddg.search.bind(ddg) },
  // Only when a key is set; read on every search, so a change applies at once.
  { name: 'paid', enabled: () => Boolean(settings.apiKey), search: (q, o) => paidApi.search(q, o) },
], { cooldownMs: 5 * 60_000, logger });
```

- A provider that throws is skipped for `cooldownMs` (it is tried last, not dropped, so a lone survivor still runs).
- One that finds nothing passes the query on without a penalty; if nobody finds anything, the answer is no results.
- It throws only when every enabled provider failed. `lastProvider` tells which one answered.

Put the cheap providers first: a paid API or a browser only runs when the free ones cannot answer.

## BrowserPort, the browser pack and its policy

```ts
interface BrowserPort {
  open(userId, profile, url, signal): Promise<BrowserPage>;
  snapshot(userId, profile, signal): Promise<BrowserPage>;
  act(userId, profile, action: BrowserAction, signal): Promise<BrowserPage>;
  // options: highlight outlines a ref (approvals); jpeg saves a smaller file.
  screenshot(userId, profile, signal, options?: { highlight?: string; jpeg?: boolean }): Promise<{ path: string }>;
  currentUrl(userId, profile): Promise<string | null>;
  // Optional: what a ref is, so approvals can name it ("Sign in", a button). null when it is gone.
  element?(userId, profile, ref): Promise<{ role: string; label: string; password: boolean } | null>;
  close(userId, profile): Promise<void>;
  // Optional: a page read in a tab of its own and closed, so parallel reads share no profile and start no extra browser.
  read?(userId, url, signal): Promise<BrowserPage>;
  // Optional: the open page's text as Markdown, page after page, one batch per call (browser_save_pages).
  readPages?(userId, profile, request: PageReadRequest, signal): Promise<PageReadBatch>;
}
type BrowserAction =
  | { kind: 'click'; ref: string }
  | { kind: 'type'; ref: string; text: string; submit: boolean }
  | { kind: 'press'; key: string }
  | { kind: 'scroll'; direction: 'up' | 'down' }
  | { kind: 'back' };
interface BrowserPage { url: string; title: string; snapshot: string }
```

- **Profiles** are cookie jars: `"default"`, or a name per site (`"outlook"`) so one login does not leak into another.
  Keep them between runs: that is what lets a user log in once.
- **Snapshots** are text for the model: an outline of the page (an accessibility tree works well) where every element
  the agent can use carries a ref like `[@e12]`. The tools send up to 12,000 characters and tell the model to scroll
  for more. Snapshots are untrusted content.
- `browser_screenshot` saves a PNG into the workspace and returns its path; the model gets the path, the user sees the
  picture in their files.
- **Approvals** for `click`, `type` and `press` name the element and the site (with `element`) and attach a screenshot
  with the element outlined (`ApprovalText.image`), so the user sees what they approve. Text for a password field shows
  as dots. Every part is optional: if `element` or the screenshot fails, the approval still appears.

### Who decides what the agent may do

Reading (`open`, `snapshot`, `scroll`, `back`, `screenshot`, `close`) always runs. Acting (`click`, `type`, `press`)
goes through a **gate** (see [Tools](tools.md#the-tool-fields)) that asks your policy about the page it would happen on:

```ts
type BrowserPolicy = (userId: string, url: string, action: 'click' | 'type' | 'press' | ...) =>
  Promise<'allow' | 'approve' | { block: string }>;
```

| Policy answer | Chat run | Scheduled run |
|---|---|---|
| `'allow'` | runs | runs |
| `'approve'` | waits for the user's approval, like an external tool | refused: nobody is there to approve |
| `{ block }` | refused with your message | refused |
| no policy given | every action asks | refused |

StudyHawk, for example, allows actions on domains the user marked as trusted, asks everywhere else, and blocks every
action on the school's Canvas (the app is read-only there; it reads Canvas through its API tools).

All browser tools are main-agent-only: subagents cannot drive the user's logged-in browser.

## Saving a long text: browser_save_pages

Some texts can only be read in the browser: an e-book reader with no download, a chapter split into pages, a long
article. Reading them with `browser_snapshot` puts every page into the conversation (12,000 characters at a time), and
on a site that is not trusted every click on "Next" asks again. `browser_save_pages` reads the open page as Markdown,
turns page after page, and writes the text **straight into a workspace file**: the model only gets back the path, the
title, the number of pages and why it stopped. With `rag`, the file is then added to that collection (created if
missing) with the same code as `rag_add`, so the agent answers from it with `rag_ask`.

The agent opens the first page (signing in if needed), takes a snapshot to find the way forward, then calls:

```ts
browser_save_pages({
  path: 'Books/Financial Accounting.md', // .md is added if missing; replaced if it exists
  turn: 'click',                         // 'click' | 'press' | 'scroll' | 'none'
  ref: '@e12',                           // with 'click': the "Next page" control from the snapshot
  key: 'ArrowRight',                     // with 'press': ArrowRight, ArrowDown, PageDown or Space
  max_pages: 500,                        // default 500, at most 2,000
  rag: 'ACG 2021 textbook',              // optional: index the file when done
});
```

It stops at the last page (turning changes nothing, or the next control is gone or disabled), at `max_pages`, or at
its own limits (20 MB of text, 25 minutes of reading): then the result says it is not finished, and a second call with
a new path goes on from where the browser is. A reader that draws its pages as pictures (a canvas, page images) has no
text: the tool fails with a message telling the agent to say so to the user instead of retrying. It does not run OCR.

**Approval.** `turn: 'click'` and `'press'` act on the site, so they go through the same gate as `browser_click` with
your `BrowserPolicy`, but **once for the whole reading**: the approval reads "Read up to 500 pages on reader.example,
clicking "Next page" (button) to turn each page, and save them" with a screenshot of the control outlined. `'scroll'` and
`'none'` only read, so they run without asking. In scheduled runs only what the policy allows outright runs.

**The host's side** is `readPages`, one batch per call so no single request runs for minutes:

```ts
interface PageReadRequest {
  start: boolean; // true: read the page that is open; false: turn first, then read
  turn: { kind: 'none' } | { kind: 'click'; ref: string } | { kind: 'press'; key: string } | { kind: 'scroll' };
  pages: number;  // at most this many pages in this batch (stop sooner to answer in time)
}
interface PageReadBatch {
  url: string;
  title: string;
  markdown: string; // only the new text of this batch
  pages: number;
  end: 'last-page' | 'no-text' | 'done' | null; // null: there is more
  images?: boolean; // with 'no-text': the page shows large images or canvases
}
```

The engine calls it with `start: true`, then with `start: false` until `end` is set, appending each batch's `markdown`
to the file. Between calls the host keeps, per profile, what the last page had, so text the next page repeats (a
running header, the part of a long page a scroll kept on screen) is returned once. A `click` turn should find its
control again after the page re-renders (by its name), and treat a disabled control as the last page. StudyHawk's
sandbox runner does this in the browser: it reads the main content (`main`, `article`) of the page and of its visible
frames (readers often render in an iframe) and open shadow roots, leaves out menus, toolbars, buttons and forms, and
writes headings, lists, quotes, code and tables as Markdown.

The tool is offered only when the port has `readPages` and the engine has a `workspace`. The text is the user's own
copy, for their own study: keep it in their files, out of anything shared.

## Writing a gate for your own tools

The browser pack is built on a generic feature: any tool can have a `gate(args, ctx)` that runs before the call and
returns `'run'`, `'approve'` or `{ refuse: message }`. Use it when the risk of a call depends on its arguments or on
state, for example "transfers under $20 run, larger ones ask". `ctx` has `user`, `runKind`, `host`, `browser` and
`browserPolicy`.
