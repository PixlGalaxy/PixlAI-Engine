# API reference

Everything `pixlai-engine` exports, grouped by what you use it for. Types are TypeScript-only; everything else is a runtime value. Each entry links to the page that explains it.

## Engine

| Export | What it is |
|---|---|
| `createEngine(options)` | Builds the engine once per process: stores, base prompt, your tools and the optional ports. [Getting started](getting-started.md) |
| `Engine` | `forUser(user, { limits?, host? })` returns a `UserAgent`. |
| `EngineOptions` | `stores`, `basePrompt`, `tools?`, `disableBuiltins?`, `limits?`, `logger?`, `clock?`, and the optional ports (`workspace`, `extractor`, `embeddings`, `sharedRags`, `sandbox`, `search`, `fetcher`, `browser`, `browserPolicy`, `personalData`). |
| `UserAgent` | `run(options)`, `runSubagents(options)`, `callTool(name, args, options?)` (one tool outside a conversation, e.g. for an MCP server: same gates, timeout and untrusted wrapping; tools that need an approval are refused), `tools()`, `user`, `limits`. |
| `RunOptions` | `runId`, `model`, `history`, `sink`, `signal?`, `kind?` (`chat` / `scheduled`), `toolFilter?`, `reasoning?`, `notes?` (the host's notes for this run, added to the system prompt and inherited by helpers), `startBackground?`, `helperModels?`. [Concepts](concepts.md#runs-and-the-loop) |
| `SubagentRunOptions` | `runId`, `model`, `tasks`, `sink`, `signal?`, `toolFilter?`, `helperModels?`, `notes?`, for background helpers. [Concepts](concepts.md#background-delegation) |
| `RunResult` | `status`, `content`, `messages`, `toolCalls`, `usage`, `error?`, `awaitingUser?`. [Concepts](concepts.md#runresult) |
| `Limits`, `DEFAULT_LIMITS` | Step, token, delegation, schedule, timeout and memory-size limits. [Concepts](concepts.md#limits) |
| `UserProfile` | `id`, `name`, `language`, `timezone`, `facts?`. |

## Models

| Export | What it is |
|---|---|
| `ModelProvider` | `stream(request)` yielding `ModelChunk`s. [Ports](ports.md#modelprovider-and-resolvedmodel) |
| `ModelRequest`, `ModelChunk` | What a provider receives and yields (`text`, `tool_call`, `usage`, `done`). |
| `ResolvedModel` | The model chosen for a run: provider, name, label, ref, tool support, context window. |
| `ChatMessage`, `ChatImage`, `ToolCallRequest`, `ToolSpec`, `JsonSchema` | Conversation and tool-schema shapes; `ChatImage` is a picture in a user turn. |
| `HelperModel`, `HelperModels` | The models the agent may give its helpers. [Concepts](concepts.md#choosing-a-model-per-helper) |
| `toProviderMessages(messages)` | Adds the out-of-band marker to steers before a provider call (the loop does this; use it if you call a provider yourself). |
| `estimateTokens`, `COMPACT_THRESHOLD` | The size estimate (4 characters per token) and the 0.75 threshold compaction uses. |
| `compactHistory(history, model, signal, keep?)` | Compaction on demand (a "compact" button): summarizes all but the newest messages; returns `{ summary, keepFrom }` for the host to store, or null when there is too little. |
| `SUMMARY_PREFIX` | The line a compaction summary starts with, to recognize one in a stored history. |
| `ReasoningLevel` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`: `RunOptions.reasoning` passes it to `ModelRequest.reasoning`; providers map it to their own setting. |

## Events

| Export | What it is |
|---|---|
| `EngineEvent` | Everything a run reports. [Concepts](concepts.md#events) |
| `EventSink` | `{ emit(event) }`, awaited by the loop. |
| `RunStatus` | `running`, `waiting_approval`, `waiting_mfa`, `done`, `failed`, `cancelled`. |
| `ToolCallView`, `ApprovalView`, `PlanStep` | Payloads of `tool_call` / `tool_result`, `approval_required` and `plan`. |

## Tools

| Export | What it is |
|---|---|
| `defineTool(tool)` | Declares a tool with typed arguments. [Tools](tools.md) |
| `Tool`, `ToolContext`, `GateContext`, `ApprovalText`, `RunKind`, `SubagentOutcome` | The tool contract and what a tool receives. |
| `ToolRegistry` | The list of tools a run offers (`get`, `list`, `filter`). |
| `BUILTIN_TOOLS` | `time_now`, `memory_update`, `skills_load`, `skills_note`. |
| `CORE_TOOLS`, `askUser`, `calc`, `notify`, `planUpdate` | Core tools; `evaluate(expression)` is the safe calculator behind `calc`. |
| `questionsAsText(questions)` | `ask_user` questions as plain text: what the conversation keeps, for clients that cannot show choices. |
| `DISPLAY_TOOLS`, `showHtml` | `show_html`, offered with `EngineOptions.displays: ['html']`. |
| `toolsLoad`, `inGroup(group, tools)`, `toolSummary(tool)`, `ENGINE_GROUP_NOTES` | Lazy tool groups: the `tools_load` tool, a group's tools, a tool's one-line summary, and the engine packs' lines in the list of groups. [Tools](tools.md) |
| `CRON_TOOLS`, `SCHEDULED_RUN_NOTE` | `cron_create/list/update/delete`, and the note added to scheduled runs. |
| `FILES_TOOLS`, `cleanPath`, `RAG_DIR`, `assertNotRag` | The files pack (needs a workspace) and its path rules. [Workspace and RAG](workspace-and-rag.md) |
| `isHidden(workspace, path)`, `assertVisible(workspace, path)` | Whether a path is one the host hides (`WorkspacePort.hidden`), and the "Not found" check the built-in tools use, for tools of your own. |
| `RAG_TOOLS`, `UserRags`, `chunkPages`, `ragId`, `RagManifest`, `RagSource`, `Chunk` | The RAG pack and its storage helpers. |
| `CODE_TOOLS`, `codeRun`, `clipMiddle` | `code_run` over a `SandboxPort`. [Code, web and browser](code-web-browser.md) |
| `WEB_TOOLS`, `webSearch`, `webFetch`, `webDownload`, `htmlToText`, `decodeEntities` | The web pack and its HTML-to-text helpers. |
| `BROWSER_TOOLS` | `browser_open`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_back`, `browser_screenshot`, `browser_close`. |
| `programRisk(code, sites, personalValues)`, `siteOf(raw)` | How risky a program that drives a browser reads (code_run with `browser_sites`), and a declared site as a host name. [Programs that drive a browser](code-web-browser.md#programs-that-drive-a-browser-code_run-with-browser_sites) |
| `browserRunJs`, `scriptRisk(code, personalValues)` | `browser_run_js` (the agent's own JavaScript in the page; added when the browser has `evaluate`) and its reading of a script's risk. [The agent's own scripts](code-web-browser.md#the-agents-own-scripts-browser_run_js) |
| `ScriptRequest`, `ScriptResult` | `BrowserPort.evaluate`: a script to run, and what each frame returned. |
| `browserActionRisk(action, element)`, `formSummary(element)` | The routine/sensitive reading of a browser action, and what a form would send (as approvals show it). |
| `findPersonalData(text, values)`, `personalDataGate(ctx, text, what)` | Whether a URL or query carries one of the user's values, and the gate the web and browser tools use for it. |
| `browserSavePages` | `browser_save_pages`: a long text read in the browser, page after page, into a Markdown file (and a RAG). Added when the browser has `readPages` and there is a workspace. [Code, web and browser](code-web-browser.md#saving-a-long-text-browser_save_pages) |
| `browserSaveBook` | `browser_save_book`: the e-book open in a reader, from its own EPUB files in reading order, into a Markdown file (and a RAG), kept only when it reads like a book. Added when the browser has `readBook` and there is a workspace. [Code, web and browser](code-web-browser.md#saving-an-e-book-from-its-readers-files-browser_save_book) |
| `BookTextCheck` | What `browser_save_book` uses to tell a book from a reader's menus: words, prose paragraphs and how many differ. |
| `wrapUntrusted(source, text)`, `steerContent(text)` | The wrappers for third-party text and for steers. [Security](security.md) |

## Delegation

| Export | What it is |
|---|---|
| `DelegateTask`, `DelegateReport` | A helper's task (`goal`, `context?`, `model?`) and its report. |
| `backgroundReportMessage(reports)` | The message that hands background reports to the main agent. [Recipes](recipes.md#background-delegation) |
| `helperModelsNote(models)` | The prompt section listing helper models (added for you when `helperModels` is passed). |

## Memory

| Export | What it is |
|---|---|
| `MemoryStore`, `MemoryDoc`, `MemoryDocs` | SOUL.md, USER.md and MEMORY.md per user. [Concepts](concepts.md#memory) |
| `memoryUpdate` | The `memory_update` tool. |
| `applyOperations(doc, text, operations, limit)` | Applies add / patch / remove / replace with the size check, for host-side edits. |
| `entriesOf(text)`, `ENTRY_SEPARATOR`, `DOC_FILES` | Entry splitting (`§` lines) and file names. |

## Schedules

| Export | What it is |
|---|---|
| `ScheduleStore`, `Schedule` | The user's schedules. [Ports](ports.md#schedulestore) |
| `parseSchedule`, `nextRun`, `planSchedule`, `isValidTimezone`, `MIN_INTERVAL_MS`, `ParsedSchedule` | Cron, interval and one-off parsing and the next run time in a timezone. |

## Ports

| Export | What it is |
|---|---|
| `RunStore`, `PendingSteer`, `ApprovalDecision` | Steers and approvals. [Ports](ports.md#runstore) |
| `SkillStore`, `SkillSummary` | Skills per user. [Skills](skills.md) |
| `WorkspacePort`, `FileEntry`, `StorageArea`, `TextExtractor`, `EmbeddingPort`, `SharedRagSource`, `SharedRagInfo` | Files, document text, embeddings and shared RAGs. [Workspace and RAG](workspace-and-rag.md) |
| `SandboxPort`, `ExecRequest`, `ExecResult`, `CodeLanguage` | Code execution. |
| `SearchPort`, `SearchHit`, `FetchPort`, `FetchedPage` | Web search and fetching. |
| `SearchChain`, `SearchProvider`, `SearchChainOptions` | A `SearchPort` over several providers: next one on failure or no results, failed ones cool down. [Docs](code-web-browser.md#several-search-providers-searchchain) |
| `BrowserPort`, `BrowserPage`, `BrowserAction`, `BrowserPolicy` | A real browser and where it may act. |
| `BrowserElement`, `BrowserForm`, `ActionRisk` | What an action is done on, and how risky it reads. [Routine or sensitive](code-web-browser.md#routine-or-sensitive-browseractionrisk) |
| `PersonalDataSource` | `EngineOptions.personalData`: the user's identifying values. [Links that carry the user's data](code-web-browser.md#links-that-carry-the-users-data) |
| `PageTurn`, `PageReadRequest`, `PageReadBatch` | `BrowserPort.readPages`: how to reach the next page, and one batch of read text. |
| `Logger`, `Clock` | Optional logging and time source. |

## In-memory stores

`InMemoryRunStore` (adds `steer(runId, text)` and `decide(approvalId, decision)` for hosts and tests), `InMemoryMemoryStore`, `InMemorySkillStore` (takes the skills as an array), `InMemoryScheduleStore` and `InMemoryWorkspace`. They implement the ports for tests and single-process hosts.
