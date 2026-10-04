# AI Copilot Bridge

Multi-agent coding assistant for VS Code: **Lead AI = Copilot model AUTO (GPT / Claude / whatever you pick)** + **local Ollama model (worker with Copilot tools)**.

Chat participant: `@multi` — the model picker next to `@multi` decides the lead (GPTดี/Claudeดีแล้วแต่งาน).

```
USER
  v
@multi (Chat Participant)
  v
Lead AI (decides, uses VS Code tools, answers)
  +-- native VS Code / Copilot / MCP tools (file, search, terminal...)
  +-- Qwen via Ollama (worker WITH Copilot tools, lead-approved)
  v
Final Markdown answer
```

Lead has final authority. Qwen never overrides Lead.

## Workflow (lead-light: save lead tokens, local carries the load)

1. **Lead understands from text + free snapshot** — every request ships the
   workspace root + file list, so orders are specific on turn 1 with zero
   extra Lead calls.
2. **Qwen executes** (thinking off, text tool blocks). Reads auto-run.
   User-explicit new-file writes skip Lead approval entirely (existence
   checked — overwrites still gated). Other mutations: Lead allows, or you
   confirm when Lead says `ask_user`.
3. **Lead verifies cheaply** (trusts tool results, spot-checks only on doubt).

## Requirements (for every user)

1. **VS Code** 1.139+ with **GitHub Copilot** + **Copilot Chat** extensions, signed in with an active Copilot subscription.
2. **Ollama** running locally (only needed when you want local AI help):
   - Install: https://ollama.com
   - `ollama serve`
   - `ollama pull qwen3:4b`
   - Verify: `curl http://localhost:11434/api/tags`

Without Ollama, `@multi` still works (GPT-only mode). With Ollama offline, you get a warning and GPT continues alone — the chat does not crash.

## Install (from source)

```powershell
git clone <repo-url>
cd ai-copilot-bridge
npm install
npm run compile
```

Press **F5** to launch the Extension Development Host, then in Chat:

```
@multi Explain what this extension does.
```

To install permanently: `npm run package` then install the `.vsix` via
Extensions view > `...` > Install from VSIX.

Prebuilt: `ai-copilot-bridge-<version>.vsix` in the project root (built with
`npx @vscode/vsce package`). Same install steps. Requires VS Code 1.139+,
GitHub Copilot subscription, and Ollama for the local side.

## Extension Settings

Contributed via `contributes.configuration`:

* `aiCopilotBridge.ollama.url` (default `http://localhost:11434`)
* `aiCopilotBridge.ollama.model` (default `qwen3:4b`)
* `aiCopilotBridge.ollama.timeout` (default `180000` ms) — increase on slow PCs
* `aiCopilotBridge.ollama.askBeforeSkip` (default `true`) — Qwen timeout แล้วถามก่อน: Wait (รอต่อ) / Skip
* `aiCopilotBridge.ollama.showThinking` (default `true`) — show Qwen thinking trace
* `aiCopilotBridge.ollama.thinkingCollapsed` (default `true`) — native collapsible `+ Thinking` block (click to expand), inline quote dump when off
* `aiCopilotBridge.qwenToolsEnabled` (default `true`) — Qwen agentic mode on Copilot tools
* `aiCopilotBridge.qwenMaxToolSteps` (default `8`) — max tool steps per Qwen task
* `aiCopilotBridge.qwenMaxTools` (default `8`) — Copilot tools exposed to Qwen (small models drown in too many)
* `aiCopilotBridge.qwenAgentThink` (default `false`) — agentic thinking; off = Qwen acts immediately without deliberating (recommended: it burned whole steps thinking and never acted), Lead reviews all actions
* `aiCopilotBridge.enableTools` (default `true`) —ปิดถ้าเจอ `Auto mode needs a prompt` บ่อย
* `aiCopilotBridge.maxRounds` (default `5`, max `15`)

Change per-machine in VS Code Settings UI — no code edits needed.

## Usage

| Test | Command | Expected |
|------|---------|----------|
| Basic GPT | `@multi Explain what this extension does.` | GPT answers directly, no Qwen call |
| Local AI | `@multi Ask the local AI to explain TCP vs UDP.` | `### Qwen — Local AI` section appears |
| Native tools | `@multi Inspect this workspace and list main files.` | Progress `GPT is using VS Code tools...`, then grounded answer |
| Copilot missing | sign out of Copilot, run `@multi hi` | Friendly sign-in instructions, no stack trace |
| Ollama offline | stop Ollama, ask a Qwen question | Warning + GPT-only continuation |

How it decides per turn:
1. Tool call needed → runs `vscode.lm.invokeTool`, feeds result back to GPT.
2. Qwen useful → GPT returns `{"action":"ask|delegate|discuss","message":"..."}`.
3. Otherwise → plain Markdown = final answer (no JSON required).

## Local model speed (important on weak PCs)

Qwen does the work, so it must be FAST. Thinking models deliberate for minutes
on CPU; non-thinking small models act immediately. Switch anytime via
`aiCopilotBridge.ollama.model` (then `ollama pull <model>`):

| Model | Speed (CPU) | Thinking | Tool use | Best for |
|---|---|---|---|---|
| `qwen2.5:3b` | fast | none (acts now) | mature | RECOMMENDED default for agentic file work |
| `llama3.2:3b` | fast | none | good | alternative when qwen2.5 misbehaves |
| `qwen3:4b` | slow | heavy | good | quality analysis when you have time/CPU |
| `qwen3:1.7b` | fastest | light | weak | trivial tasks only |

Text-mode Q&A keeps thinking whatever the model; agentic steps run with
thinking off (`qwenAgentThink` can re-enable it).

## Qwen tools (agentic local AI)

Yes — Qwen can use GitHub Copilot / VS Code tools. The bridge sends a
task-ranked subset of `vscode.lm.tools` schemas to Ollama (native
tool-calling) and runs Qwen's calls via `vscode.lm.invokeTool` with the same
chat token, so Qwen gets real file/search/terminal power without duplicating
anything. Small local models get max 8 Copilot tools (see `qwenMaxTools`). Timeout counts
silence only: thinking time never trips it (absolute cap is 4x the setting).

Plus guaranteed BASIC tools (`local_read_file`, `local_list_dir`,
`local_search`, `local_write_file`, `local_edit_file`, `local_run`,
sandboxed to the workspace): these are always exposed first, so Qwen can
read/write even on machines where no file-writing Copilot tool is registered.

Approval chain per mutating call (write/edit/delete/run):
1. Reads run automatically. Anything mutating pauses for the **Lead**.
2. Lead answers `allow` → runs. `deny` → Qwen is told why and adapts.
3. Lead answers `ask_user` → **you** get a dialog (Allow once / Deny).
4. Unknown tools default to needing approval. Lead unreachable → human decides.

Try: `@multi /models` lists Copilot models; ask Qwen to create `TEST.md` and
watch reads auto-run while user-explicit new files skip Lead approval.

## Verify-then-redo

After Qwen acts with tools on a file task, the bridge checks the named files
on disk directly (zero Lead tokens): pass → Lead confirms immediately; fail →
Lead must redo (itself or one more Qwen round), never report success on
missing files.

## Troubleshooting

* `Auto mode needs a prompt or a command to route a request` — fixed with 2 layers: (1) exclude prompt-router meta tools, (2) auto-retry without tools + disable tools for the rest of the request. If it persists, set `aiCopilotBridge.enableTools=false` or pick another Chat model.
* `Cannot reach Ollama at ...` — run `ollama serve` + `ollama pull qwen3:4b`, check `aiCopilotBridge.ollama.url`. On slow PCs raise timeout or press **Retry Qwen** when asked.
* Qwen asked to create files? — Qwen now HAS Copilot tools in agentic mode (delegate/file tasks): reads auto-run, writes/commands wait for Lead approval (and you, when Lead says `ask_user`). Text-only `ask` mode still just drafts content for Lead to write.
* `Ollama model "..." not found` — `ollama pull <model>` or change `aiCopilotBridge.ollama.model`.
* `No Copilot language model available` — install/sign in Copilot, Copilot Chat.
* Slow local inference — raise timeout, use smaller model, or just let GPT answer (Qwen is optional).

## Project layout

* `src/extension.ts` — registers `ai-copilot-bridge.multi`, error/cancel handling, `showLastThinking` command.
* `src/orchestrator.ts` — Lead loop, `selectTools()`, `executeTools()`, Qwen delegation (text + agentic), lead approval gate, finalization.
* `src/ollama.ts` — `/api/chat` streaming (live thinking + answer) and non-streaming tool steps, timeout + cancellation, clear errors.
* `src/context.ts` — workspace file list + active file/selection to ground Qwen.
* `package.json` — participant + settings contributions.
* `INFO.MD` — full continuation spec / architecture history.

## Development Rules

* Minimal patches, compile after change: `npm run compile`.
* Compile success != runtime success — always test in Extension Development Host (F5).
* Never claim tools/Qwen ran unless results returned to GPT.
