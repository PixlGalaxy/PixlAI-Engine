/**
 * Ports: what a host implements to run PixlAI-Engine. A typical host backs them
 * with Postgres; the tests use the in-memory versions in `memory-stores.ts`.
 * The engine keeps no state of its own between calls, so a host with several
 * processes works as long as these are shared.
 */

export interface PendingSteer {
  id: string;
  content: string;
}

export type ApprovalDecision = 'approved' | 'rejected' | 'expired';

export interface RunStore {
  /** Steers sent for this run that have not been applied yet; marks them applied. */
  takeSteers(runId: string): Promise<PendingSteer[]>;
  /** Calls `onSteer` as soon as a steer arrives (used to interrupt a generation). Returns unsubscribe. */
  watchSteers(runId: string, onSteer: () => void): () => void;
  createApproval(input: {
    runId: string;
    userId: string;
    toolName: string;
    args: Record<string, unknown>;
    summary: string;
    details: Record<string, string>;
    /** A workspace picture of what will happen (the page with the element outlined). */
    image?: string;
  }): Promise<{ id: string }>;
  /** Resolves when the user decides, the timeout passes ('expired') or the signal aborts. */
  waitForApproval(approvalId: string, timeoutMs: number, signal: AbortSignal): Promise<ApprovalDecision>;
}

/**
 * The agent's markdown files for one user, in the style of Hermes Agent:
 * SOUL.md (its personality), USER.md (who the user is) and MEMORY.md (its own
 * notes). All three go into every conversation; the agent edits them with
 * memory_update and the user can edit them too.
 */
export type MemoryDoc = 'soul' | 'user' | 'notes';
export type MemoryDocs = Record<MemoryDoc, string>;

export interface MemoryStore {
  /** Empty strings for files that do not exist yet. */
  read(userId: string): Promise<MemoryDocs>;
  write(userId: string, doc: MemoryDoc, content: string): Promise<void>;
}

export interface SkillSummary {
  slug: string;
  name: string;
  description: string;
}

export interface SkillStore {
  /** Enabled skills for this user (built-in, organization and personal). */
  list(userId: string): Promise<SkillSummary[]>;
  /** Full instructions of one skill, or null if it is not available to the user. */
  load(userId: string, slug: string): Promise<{ name: string; body: string; notes: string[] } | null>;
  /** A short lesson learned while using the skill, shown next time it loads. */
  addNote(userId: string, slug: string, note: string): Promise<void>;
}

export interface Schedule {
  id: string;
  name: string;
  /** Cron expression ("0 8 * * 1"), an interval ("every 2h") or an ISO date for a one-off. */
  schedule: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export interface ScheduleStore {
  list(userId: string): Promise<Schedule[]>;
  create(userId: string, input: Omit<Schedule, 'id' | 'lastRunAt'>): Promise<Schedule>;
  update(userId: string, id: string, patch: Partial<Omit<Schedule, 'id'>>): Promise<Schedule | null>;
  remove(userId: string, id: string): Promise<boolean>;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, detail?: unknown): void;
}

export interface Clock {
  now(): Date;
}

// ------------------------------------------------------------------ workspace (files pack)

export interface FileEntry {
  /** Path relative to the user's root, with `/` separators, e.g. "Fall 2026/ACG 2021/notes.md". */
  path: string;
  name: string;
  type: 'file' | 'dir';
  size: number;
  modifiedAt: string;
}

export interface StorageArea {
  /** e.g. "workspace" or "TEMP". */
  name: string;
  usedBytes: number;
  limitBytes: number;
  /** Rule the agent must know, e.g. "files here are deleted 24 h after their last change". */
  note?: string;
}

/**
 * A user's files. Paths are always relative to the user's own root; the host
 * maps them to real storage, enforces quotas and refuses anything outside the
 * root. How areas are laid out (e.g. a "TEMP/" folder with its own quota) is
 * the host's choice, explained to the model through `describe`.
 */
export interface WorkspacePort {
  /** Text for the system prompt: layout, quotas and rules (e.g. what gets deleted when). */
  describe(userId: string): Promise<string>;
  list(userId: string, path: string): Promise<FileEntry[]>;
  stat(userId: string, path: string): Promise<FileEntry | null>;
  read(userId: string, path: string): Promise<Buffer>;
  /** Creates parent folders as needed. Throws when the quota would be exceeded. */
  write(userId: string, path: string, data: Buffer | string, options?: { append?: boolean }): Promise<void>;
  mkdir(userId: string, path: string): Promise<void>;
  move(userId: string, from: string, to: string): Promise<void>;
  /** Folders are deleted with their contents. */
  delete(userId: string, path: string): Promise<void>;
  usage(userId: string): Promise<StorageArea[]>;
  /**
   * Optional: paths the host keeps for itself (its own caches). The file tools neither list nor open them,
   * so to the agent they do not exist.
   */
  hidden?(path: string): boolean;
}

/** Turns documents into text. Return null for formats it does not handle. */
export interface TextExtractor {
  extract(data: Buffer, filename: string): Promise<{ pages: string[] } | null>;
}

/** Text embeddings for RAG. Vectors of every call must have the same length for one `model`. */
export interface EmbeddingPort {
  /** Identifies the embedding space; a RAG built with one model cannot be searched with another. */
  readonly model: string;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface SharedRagInfo {
  /** Unique id, e.g. "course-123/textbook". Shown to the model as "shared:<id>". */
  id: string;
  name: string;
  description: string;
  model: string;
  chunks: number;
}

/**
 * Read-only collections someone else built for this user to search (e.g. an
 * instructor's RAG of the course textbook). Optional: without it, users only
 * see their own RAGs. Files use the same format as a user RAG (manifest.json,
 * chunks.jsonl, vectors.f32).
 */
export interface SharedRagSource {
  list(userId: string): Promise<SharedRagInfo[]>;
  readFile(userId: string, id: string, file: 'manifest.json' | 'chunks.jsonl' | 'vectors.f32'): Promise<Buffer | null>;
}

// ------------------------------------------------------------------ sandbox (code pack)

export type CodeLanguage = 'python' | 'node' | 'shell';

export interface ExecRequest {
  language: CodeLanguage;
  code: string;
  /** Working directory relative to the user's workspace root ("" is the root). */
  cwd: string;
  timeoutMs: number;
  /**
   * A browser for the program (code_run with browser_sites): the host starts one the program can drive (for
   * example over the Chrome DevTools Protocol, its address in an environment variable), holding the user's
   * sign-ins for these sites only, and closes it when the program ends. Hosts that cannot ignore it.
   */
  browser?: { sites: string[] };
}

export interface ExecResult {
  /** null when the process was killed (timeout, memory limit). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  /** Workspace files the run created or changed, when the host can tell. */
  files?: { path: string; size: number }[];
}

/**
 * Runs code for a user in an isolated environment where their workspace is
 * the working tree (the same files the WorkspacePort serves). Isolation,
 * resource limits and network policy are the host's job.
 */
export interface SandboxPort {
  /** One line for the system prompt: what is installed and what is not allowed (e.g. "no network"). */
  describe(userId: string): Promise<string>;
  exec(userId: string, request: ExecRequest, signal: AbortSignal): Promise<ExecResult>;
}

// ------------------------------------------------------------------ web (web pack)

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Web search. Any backend: a metasearch engine (SearXNG), an API (Brave, Google CSE), a scraper. */
export interface SearchPort {
  /** `userId`: who is searching, for providers that act per user (e.g. their own browser). */
  search(query: string, options: { limit: number; language?: string; signal: AbortSignal; userId?: string }): Promise<SearchHit[]>;
}

export interface FetchedPage {
  /** Final URL after redirects. */
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
}

/**
 * Downloads a public URL. The host enforces the network policy: block private
 * addresses (SSRF), cap the size, follow redirects safely.
 */
export interface FetchPort {
  fetch(url: string, options: { maxBytes: number; signal: AbortSignal }): Promise<FetchedPage>;
}

// ------------------------------------------------------------------ browser (browser pack)

export interface BrowserPage {
  url: string;
  title: string;
  /**
   * The page as text for the model: an accessibility-tree outline where every
   * interactive element carries a ref like [@e12] for click/type.
   */
  snapshot: string;
}

export type BrowserAction =
  | { kind: 'click'; ref: string }
  | { kind: 'type'; ref: string; text: string; submit: boolean }
  | { kind: 'press'; key: string }
  | { kind: 'scroll'; direction: 'up' | 'down' }
  | { kind: 'back' };

/**
 * A real browser per user. `profile` separates cookie jars (e.g. "default",
 * "outlook"); profiles persist between runs so logins survive.
 */
export interface BrowserPort {
  open(userId: string, profile: string, url: string, signal: AbortSignal): Promise<BrowserPage>;
  snapshot(userId: string, profile: string, signal: AbortSignal): Promise<BrowserPage>;
  act(userId: string, profile: string, action: BrowserAction, signal: AbortSignal): Promise<BrowserPage>;
  /**
   * Saves a picture of the visible page into the workspace and returns its path (PNG). `highlight`: a ref to
   * outline (an approval showing what will be clicked); `jpeg`: a smaller file, for pictures only glanced at.
   */
  screenshot(userId: string, profile: string, signal: AbortSignal, options?: { highlight?: string; jpeg?: boolean }): Promise<{ path: string }>;
  /**
   * Optional: what a ref from the latest snapshot is ("button", "Sign in"), so approvals can name it and the
   * risk of an action can be told (see browserActionRisk). `ref` "focus" is the element that has the focus
   * (what a key press goes to). Null when it is gone; hosts without it get approvals that only give the ref,
   * and every action counts as sensitive.
   */
  element?(userId: string, profile: string, ref: string): Promise<BrowserElement | null>;
  /** URL of the open page, or null when the profile has no page open. */
  currentUrl(userId: string, profile: string): Promise<string | null>;
  close(userId: string, profile: string): Promise<void>;
  /**
   * Optional: reads a page in a tab of its own and closes it, apart from every profile, so several reads can
   * run at once (helpers in parallel) without stepping on each other. web_fetch uses it for pages that need a
   * browser; without it, it opens and closes a "reader" profile.
   */
  read?(userId: string, url: string, signal: AbortSignal): Promise<BrowserPage>;
  /**
   * Optional: reads the open page's text as Markdown and turns page after page, for browser_save_pages (a
   * book or long reader with no download). One call is one batch: `start` reads the page that is open, a later
   * call turns first and goes on. Text the next page repeats (a running header, what a scroll kept on screen)
   * is returned once. Without it browser_save_pages is not offered.
   */
  readPages?(userId: string, profile: string, request: PageReadRequest, signal: AbortSignal): Promise<PageReadBatch>;
  /**
   * Optional: reads the e-book the open reader shows from its own package (an EPUB: `content.opf`, its spine and
   * the chapter files), fetched inside the reader with its own session, for browser_save_book. One call is one
   * batch of chapters: `start` finds the package, a later call goes on where the last one stopped. Throws when the
   * reader has no package to read (it then says so, so the agent can turn pages with browser_save_pages instead) or
   * when the reader's session is over. Without it browser_save_book is not offered.
   */
  readBook?(userId: string, profile: string, request: BookReadRequest, signal: AbortSignal): Promise<BookReadBatch>;
  /**
   * Optional: runs the agent's own script in the open page (browser_run_js). `code` is the body of an async
   * function: it may await and returns its result, which must come back as JSON. `frames` "all" runs it in
   * every frame of the page too. Without it browser_run_js is not offered.
   */
  evaluate?(userId: string, profile: string, request: ScriptRequest, signal: AbortSignal): Promise<ScriptResult>;
}

export interface ScriptRequest {
  code: string;
  frames: 'main' | 'all';
  timeoutMs: number;
}

export interface ScriptResult {
  url: string;
  title: string;
  /** One per frame it ran in (only the page itself with frames "main"): its result, or why it failed. */
  results: { frame: string; result?: unknown; error?: string }[];
}

export interface BookReadRequest {
  start: boolean;
  /** At most this many chapter files in this batch (the host may stop sooner, to answer in time). */
  sections: number;
}

export interface BookReadBatch {
  /** The reader page. */
  url: string;
  /** The book's title, from its package (or the reader page's title). */
  title: string;
  /** Chapter files in the book's reading order (its spine). */
  total: number;
  /** This batch, in reading order: each chapter file as Markdown, with its page markers when the book has them. */
  sections: { index: number; title: string; markdown: string; images: number }[];
  /** Every chapter file has been read. */
  end: boolean;
}

/** How browser_save_pages gets to the next page. */
export type PageTurn = { kind: 'none' } | { kind: 'click'; ref: string } | { kind: 'press'; key: string } | { kind: 'scroll' };

export interface PageReadRequest {
  start: boolean;
  turn: PageTurn;
  /** At most this many pages in this batch (the host may stop sooner, to answer in time). */
  pages: number;
}

export interface PageReadBatch {
  url: string;
  title: string;
  /** The new text of this batch, as Markdown. */
  markdown: string;
  pages: number;
  /**
   * Why the reading stopped: `last-page` (turning changed nothing, or the next control is gone or disabled),
   * `no-text` (nothing to read on the first page), `done` (no turning was asked), or null when there is more.
   */
  end: 'last-page' | 'no-text' | 'done' | null;
  /** With `no-text`: the page shows large images or canvases (a reader that draws its pages as pictures). */
  images?: boolean;
}

export interface BrowserElement {
  /** As the snapshot names it: button, link, textbox, checkbox, select... */
  role: string;
  label: string;
  /** A password field: what is typed into it is never shown back. */
  password: boolean;
  /** Optional, for telling routine actions from sensitive ones. A field: what it takes. */
  field?: 'password' | 'payment' | 'email' | 'search' | 'text' | 'other';
  /** A link that goes to another page (not a button dressed as one). */
  link?: boolean;
  /** Clicking it sends its form (a submit button), or for the focused field, Enter would. */
  submits?: boolean;
  /** The form it belongs to, when it is in one: what sending it would send. */
  form?: BrowserForm;
}

export interface BrowserForm {
  /** A search box (role="search", a search field, or a form whose only field is a query). */
  search: boolean;
  password: boolean;
  payment: boolean;
  /** Its filled fields as the user would see them (passwords as dots), for the approval. */
  fields: { label: string; value: string }[];
}

/** How risky a browser action is: routine (reading, navigating, filling in) or sensitive (signing in, sending, paying, deleting). */
export interface ActionRisk {
  level: 'routine' | 'sensitive';
  /** Why, in a few words ("sends a form", "a password field", "unknown element"). */
  reason: string;
}

/**
 * Decides, per action and page, whether the agent may act freely, must ask the
 * user, or may not act at all (e.g. a site that must stay read-only). `context`
 * (from this version on) has the element acted on and the engine's reading of
 * how risky the action is, so a policy can let routine actions run and ask only
 * for sensitive ones.
 */
export type BrowserPolicy = (
  userId: string,
  url: string,
  /** 'script': the agent's own code in the page (browser_run_js); its risk comes from reading the code. */
  action: BrowserAction['kind'] | 'script',
  context?: { element: BrowserElement | null; risk: ActionRisk },
) => Promise<'allow' | 'approve' | { block: string }>;

/**
 * The user's own identifying values (their email, school login, full name...): a tool call that would carry
 * one of them to a third party in a URL or a query asks first. Values shorter than 4 characters are ignored.
 */
export type PersonalDataSource = (userId: string) => Promise<string[]>;
