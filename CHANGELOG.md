# Changelog

All notable changes to PixlAI-Engine. Every breaking change is listed under **Breaking**.

## 1.4.0 (2026-11-04)

### Added

- **`browser_run_js`: the agent writes and runs its own JavaScript in the page.** For what the step-by-step browser tools do badly: reading a reader that keeps its text in an iframe or a shadow root, walking through hundreds of pages in one script, extracting a table. `code` is the body of an async function; the result comes back as JSON or, with `save_to` (and `append`), goes straight into a workspace file. Scripts that only read and click through run freely under a risk-based policy; scripts that use the network, cookies or stored data, send forms, navigate, hide what they call, touch password or payment fields, name a button that commits something or carry the user's data ask, and the approval shows the code. In scheduled runs only sites the policy allows outright run scripts. See [The agent's own scripts](docs/code-web-browser.md#the-agents-own-scripts-browser_run_js).
- **`BrowserPort.evaluate(userId, profile, request, signal)`** (optional), with `ScriptRequest` and `ScriptResult`. `BrowserPolicy` may now be asked about `action: 'script'`. `scriptRisk(code, personalValues)` and `browserRunJs` are exported.

### Fixed

- **`browser_save_pages` stopped after the first page of some readers**, and said their pages were pictures. It now finds the "Next" control again when the reader renames it as it goes ("Next page, 2 of 525"), waits after each turn until the page stops changing (a reader that reloads its frame shows it empty for a moment, which was taken as the next page), and only decides there is no text when no page in the first three had any (a book often opens on its cover). When it still does not fit a reader, its description sends the agent to `browser_run_js`.

## 1.3.0 (2026-11-03)

### Added

- **Browser actions are read as routine or sensitive.** `browserActionRisk(action, element)` reads what an action does: links, menus, "Next", typing into an ordinary field, searching and keys that send nothing are routine; typing a password or payment details, sending a form (its submit button, `submit: true`, or Enter in it), buttons that commit something (Send, Pay, Delete, Sign in, Accept...) and elements that cannot be described are sensitive. The browser gate passes the element and that reading to the policy, so a host can ask only for what matters. See [Routine or sensitive](docs/code-web-browser.md#routine-or-sensitive-browseractionrisk).
- **Approvals for sending a form show what it would send.** `browser_click` on a submit button and `browser_press` Enter in a form carry `details.sends`: each filled field with its label (passwords as dots). If a page's hidden instructions got the agent to put the user's data in a form, the user sees it first.
- **Links and searches that carry the user's data ask first.** With `EngineOptions.personalData` (`PersonalDataSource`: the user's email, logins, full name), `browser_open`, `web_fetch`, `web_download` and `web_search` ask the user when the URL or query carries one of those values (as it is, URL-encoded or in base64), and are refused where nobody can approve. See [Links that carry the user's data](docs/code-web-browser.md#links-that-carry-the-users-data).
- **`BrowserElement` says more**, all optional: `field` (password, payment, email, search, text), `link`, `submits`, and `form` (`BrowserForm`: search or not, password and payment fields, the filled fields). `BrowserPort.element` takes the ref `"focus"` for the element a key press goes to.
- Exported: `browserActionRisk`, `formSummary`, `findPersonalData`, `personalDataGate`, and the types `ActionRisk`, `BrowserForm`, `PersonalDataSource`.

### Changed

- **`BrowserPolicy` gets a fourth argument**, `context: { element, risk }`. Policies written for the three-argument form keep working unchanged. In scheduled runs, a refusal now says why the action needed the user ("sends the form").

## 1.2.0 (2026-11-03)

### Added

- **`browser_save_pages`: save a long text read in the browser.** For an online book or reader with no download: the tool reads the open page as Markdown, turns page after page (clicking a "Next" control, pressing a key or scrolling) until the last one, and writes the text straight into a workspace file, so it never fills the conversation. With `rag`, the file is then added to that collection, created if missing. Turning pages asks for one approval for the whole reading (through the `BrowserPolicy`, like `browser_click`), not one per page. A reader that draws its pages as pictures has no text: the tool says so instead of saving an empty file. See [Saving a long text](docs/code-web-browser.md#saving-a-long-text-browser_save_pages).
- **`BrowserPort.readPages(userId, profile, request, signal)`** (optional): one batch of that reading, with `PageReadRequest`, `PageReadBatch` and `PageTurn`. The tool is offered only when the port has it and there is a workspace.
- `browserSavePages` and `assertNotRag` are exported, for hosts that build their own tool lists.

## 1.1.0 (2026-10-26)

### Changed

- **`show_html` or a file, never both.** The description now tells the agent that a page to keep, reuse or download, or a long one (a quiz with many questions), goes to a `.html` file with `files_write` and a link, and that `show_html` is for a quick demo used right now: agents were showing a page and saving the same page, so the user saw it twice.

- **`ask_user` recommends only when it means it, and never in a quiz.** A recommendation is now an option's `recommended` flag (show it as a badge) instead of " (Recommended)" in the label, and the description tells the agent most questions have none. `quiz: true`, or a header that names a quiz or practice, hides any recommendation, drops descriptions that grade an option ("correct", "wrong") and shuffles the options: before, practice questions marked their right answer as recommended and listed it first. A "(Recommended)" still written in a label becomes the flag.

### Added

- **Browser approvals say what they are about.** `browser_click`, `browser_type` and `browser_press` approvals name the element and the site (`Click "Sign in" (button) on example.com`) instead of a ref like `@e7`, and carry a screenshot of the page with the element outlined. A password field's text shows as dots.
- **`ApprovalText.image`**: a workspace picture of what will happen. It reaches `RunStore.createApproval` and the `approval_required` event as `image`.
- **`BrowserPort.element(userId, profile, ref)`** (optional): what a ref is (`role`, `label`, `password`). Without it approvals keep the ref.
- **`BrowserPort.screenshot` options**: `highlight` (a ref to outline) and `jpeg` (a smaller file).
- **`WorkspacePort.hidden(path)`** (optional): paths the host keeps for itself, such as a cache of converted previews. The files, rag and web tools leave them out of listings and searches and answer "Not found" when the agent names one. `InMemoryWorkspace` has a settable `hidden` to try it. `isHidden` and `assertVisible` help tools of your own do the same.

## 1.0.2 (2026-10-16)

### Changed

- **The folded tools are listed one by one.** With lazy tool groups the prompt now shows every folded tool with a one-line summary under its group, instead of only the group's name and the tool names, and tells the agent to load and use them rather than answer from memory. The full description and parameters still arrive only once the group is loaded. In StudyHawk, answers that used a tool had dropped from 59% to 30% with the old list.

- **The rules push the agent to act.** With tools, the prompt now says to use them whenever they make the answer more correct, current or complete; to ask with `ask_user` (options the user can click) instead of writing questions in the answer; and to show a plan with `plan_update` for tasks of 3 or more steps. Each rule appears only when its tool is in the run. `ask_user` and `plan_update` have fuller descriptions with when and how to use them, and say to use them often.

- **A steer no longer cuts the answer being written.** It is applied before the next model call, or, after a final answer, right after it (the run goes on to answer the correction). The `interrupted` event now only means a dropped connection is retried. Cancel the run to stop the agent.

### Added

- `Tool.summary`: the tool's line in that list (defaults to the description's first sentence), and `toolSummary(tool)`.

## 1.0.1 (2026-10-16)

### Added

- **Lazy tool groups** (`EngineOptions.lazyToolGroups`, `toolGroupNotes`, `Tool.group`, `inGroup`): the model sees the ungrouped tools plus `tools_load`, loads the groups a task needs, and the prompt lists the groups. Engine packs are grouped as `schedules`, `rag`, `code`, `web`, `browser` and `display`. Groups already used in the conversation, and `RunOptions.toolGroups`, are loaded from the start; helpers inherit their parent's. See [Tools: Lazy tool groups](docs/tools.md#lazy-tool-groups).

## 1.0.0 (2026-10-16)

### Breaking

- **Memory is now three markdown files per user.** `MemoryStore` is `read(userId)` / `write(userId, doc, content)` over `soul` (SOUL.md, the agent's personality), `user` (USER.md, who the user is) and `notes` (MEMORY.md, the agent's own notes). All three go into every conversation. `memory_add`, `memory_search` and `memory_remove` are replaced by one `memory_update` tool that applies a batch of add / patch / remove / replace within a size limit. `MemoryItem` and `forPrompt` are gone. New limits `soulChars`, `userChars`, `notesChars` (3000, 1500, 2500). To migrate, join each user's old facts with `\n§\n` into their USER.md.
- `skills_load` returns `lessons_learned` before `instructions`, so a long skill can never cut the user's notes off.
- `subagent` events carry `model_label`.

### Added

- `BrowserPort.read(userId, url, signal)` (optional): reads a page in a tab of its own and closes it, so parallel helpers never step on each other or start a browser each. `web_fetch` uses it when present.
- **Questions with options.** `ask_user` takes 1 to 4 `questions`, each with 2 to 4 options (`multi_select` optional); `RunResult.questions` and a `questions` event let hosts show them as choices. `content` keeps a text version. The free-text `question` still works.
- **`show_html`** (with `EngineOptions.displays: ['html']`): the agent shows an interactive page in the conversation; pages come in `RunResult.displays` and a `display` event.
- Tool cards are smaller: `ToolCallView.args` clips texts over 2,000 characters, and a tool's optional `view(args)` decides what its card shows.
- `SearchChain`: one `SearchPort` over several providers (next one on a failure or no results; failed providers cool down). `SearchPort` options carry `userId`, so a provider can act per user.
- `web_fetch` reads pages drawn by JavaScript and pages behind a bot check (403, 429, 503) in the user's browser when a `BrowserPort` is configured.
- `RunOptions.notes` (and `SubagentRunOptions.notes`): context only the host knows, added to this run's system prompt and inherited by helpers, e.g. the folder where a conversation keeps its files.
- `RunOptions.reasoning` (`ReasoningLevel`) reaches `ModelRequest.reasoning`, so hosts can offer a thinking selector.
- `compactHistory` for compaction on demand: the host stores the summary and sends it before the kept messages.
- `UserAgent.callTool(name, args)` runs one tool outside a conversation (for MCP servers and other hosts), with the same context, gates, timeout and untrusted wrapping; tools that need an approval are refused.
- **Images in user messages.** `ChatMessage.images` reach models with `ResolvedModel.supportsVision`; other models get a note with the file name so tools can open it.
- `context` event before each model call with the estimated prompt size and the window.
- **Model per helper.** `RunOptions.helperModels` lists the models the agent may give its helpers, with guidance to match the model to the work (`fast`, `smart`, `code`). Each `agent_delegate` task can set `model`; unknown choices fall back to the parent's model. Reports say which model wrote them.
- **Background delegation.** With `RunOptions.startBackground`, `agent_delegate` accepts `background: true`: the run answers right away and the host runs the helpers later with `UserAgent.runSubagents`, then hands the reports back with `backgroundReportMessage`.
- **Retries for dropped model connections.** A stream cut mid-answer, a 5xx, or a 429 other than `usage_limit_reached` is retried after 1 s and 4 s. Text already shown is cleared with an `interrupted` event first.
- **Empty replies retried once** with a nudge that is not stored in the conversation.
- `mfa_required` event and `waiting_mfa` status for tools that wait on a sign-in approval on the user's phone.
- `describe(args, ctx)` can be async and read host data, so approval cards show what will really happen.
- Code, web and browser packs: `code_run` over a `SandboxPort` (Python by default), `web_search` / `web_fetch` / `web_download`, and the `browser_*` tools with a `BrowserPolicy`. Per-tool `gate` and `timeoutMs`.
- `rag_add` resumes where it stopped, skips files it already indexed and near-duplicates, and reuses vectors.
- Documentation: [Security](docs/security.md), [Skills](docs/skills.md), [Recipes](docs/recipes.md) and the [API reference](docs/reference.md).

## 0.1.0

First version: multi-user tool-calling loop with live steering, approvals for external actions, parallel subagents, cron schedules, memory, skills, a per-user file workspace with quotas and a `TEMP/` area, RAG over documents, context compaction at 75% of the window, and in-memory stores. No runtime dependencies.
