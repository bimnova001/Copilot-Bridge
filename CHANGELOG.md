# Change Log

All notable changes to the "ai-copilot-bridge" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.7.4] - 2026-10-04

- Corrective intervention: same tool rejected twice in a row triggers a free precise hint (e.g. stop `local_edit_file`, call `local_write_file` with exact keys) instead of burning all 8 steps on one mistake

## [0.7.3] - 2026-10-04

- Pre-validate tool args locally (required keys): malformed calls rejected with a corrective hint (e.g. file args in `local_run` → "did you mean `local_write_file`?") spending zero lead tokens and zero dialogs

## [0.7.2] - 2026-10-04

- Agentic step prose now visible (quoted, 600 chars): confusion no longer hides behind tool lines
- Step-budget exhaustion asks Qwen for one cheap no-tools closing summary instead of ending with a dead note

## [0.7.1] - 2026-10-04

- Lead text-written calls now execute: JSON function blocks (`{"function","arguments"}` in any key variant, fenced or bare) matching real tool names are run through the same runners with full chat visibility, instead of stalling after pretty-printed JSON
- Two-party dialogue display: `Lead (model) — orders to Qwen` (understood request + orders) then `Qwen (model) — orders received, starting`, so both sides' understanding is visible

## [0.7.0] - 2026-10-04

- Verify-then-redo: after Qwen acts on file tasks, the bridge checks named files on disk (free) — pass lets Lead confirm in one short turn, fail forces a redo and forbids success reports
- Local model speed guide (README): qwen2.5:3b recommended for agentic work (no think-loop, mature tools), llama3.2:3b alternative, qwen3:4b for quality analysis

## [0.6.1] - 2026-10-04

- Fixed silent stop after delegation: Qwen branch wrapped so any unexpected throw becomes a visible skip (Lead continues) instead of a dead chat
- Thai file requests recognized (`สร้าง/เขียน/แก้ไข/ไฟล์`): full file-task behavior (agentic tools, nudges, fast-path) for Thai prompts
- Hang-proofing: workspace scan capped at 15s; per-step progress (`Qwen working — step N/M`) + pre-flight progress so stalls are locatable

## [0.6.0] - 2026-10-04

- Redesign around two goals: (1) MINIMIZE lead tokens, (2) local carries the load
- Removed dead 0.5.0 guard (was misplaced inside an unrelated function, never ran); replaced with free grounding — workspace snapshot ships with every request, zero lead calls spent
- User-authorized fast path: user-explicit new-file writes skip Lead approval entirely (existence-checked; overwrites still gated)
- Lead approval/guidance prompts now carry exact argument schemas (fixes wrong-key directives like `file_path`)
- First-call load bonus (+120s idle, once per request) so cold model load never trips the timeout

## [0.5.1] - 2026-10-04

- Lead's own tool calls now visible in chat (`> Lead AI (name): tool(args) — done/failed`), not just transient progress
- Build for real use: packaged `ai-copilot-bridge-0.5.1.vsix` (install via Extensions > Install from VSIX); @types/vscode aligned to engines for vsce

## [0.5.0] - 2026-10-04

- Redesign: LEAD-PLANS-FIRST. Lead must understand + inspect with its own native tools BEFORE any delegation on file tasks (enforced in code, not just prompt — blind orders like "inspect the workspace" to Qwen are intercepted and turned into a self-inspection turn)
- Delegation contract: orders must be fully specified (exact paths/content/commands/verification); Qwen is hands, Lead verifies before reporting

## [0.4.0] - 2026-10-04

- Agentic thinking OFF by default (`qwenAgentThink`, default false): qwen3 burned the whole token budget deliberating and died before acting; hands act immediately, Lead reviews everything (text-mode Q&A keeps full thinking)
- Delegation is explicit now: `### Lead → Qwen (delegate)` + what-was-thrown line instead of an anonymous quote

## [0.3.9] - 2026-10-04

- Text-format tool calls (```tool JSON blocks) as primary Qwen mechanism: small models that never emit native tool_calls can still act; native calls still preferred when present, history echo synthesized for text calls
- Agentic prompt now teaches the exact block format with a concrete TEST.md example

## [0.3.8] - 2026-10-04

- Auto Lead rescue on rambling steps: first step-timeout with partial output fetches a LEAD DIRECT ORDER and retries immediately (user dialog only if that fails too)
- Token cap per agentic step (`qwenMaxTokensPerStep`, default 2000 via `num_predict`): bounds worst-case ramble time on slow PCs
- Agentic header now lists actual tool names (debug which tools Qwen really got)

## [0.3.7] - 2026-10-04

- Qwen thinks less, Lead reviews more: agentic prompt capped to 1-3 short sentences + act; confusion ("stuck/which tool/not sure") or zero tool calls on file tasks triggers Lead guidance (exact next tool call, max 2/run) instead of 180s rambles
- Dropped Copilot tools duplicating basics on file tasks (choice paralysis between two writers caused the TEST.md stall)

## [0.3.6] - 2026-10-04

- Idle-based timeout: clock resets on every token, slow thinking never trips it — only real stalls (silence) count; absolute cap 4x as backstop, distinct messages for each
- Slimmer Qwen prompt: Copilot tools default 16 -> 8, workspace list capped, "be concise" instruction — weak PCs finish instead of timing out mid-reasoning

## [0.3.5] - 2026-10-04

- Built-in BASIC tools for Qwen (`local_read_file/list_dir/search/write_file/edit_file/run`, sandboxed to workspace): always exposed first in agentic mode, so file work succeeds even with zero file-writing Copilot tools registered; Copilot tools kept as the extra set
- Approval/execution routing by `local_` prefix; system prompt lists guaranteed basics explicitly so the small model calls instead of claiming absence

## [0.3.4] - 2026-10-04

- Fixed Qwen concluding "no file tool exists": file tasks now hard-boost write/edit/create tools (+100) and force-include the best writer when missing; unrelated domains (roblox/browser/...) penalized
- Agentic system prompt now lists exact tool names so the small model calls instead of narrating
- Resume keeps thinking ON: Wait feeds back reasoning + answer tails and Qwen continues thinking briefly from there (no restart from scratch)
- Lighter Qwen context: workspace file list capped at 60 for the agent (was 100+ untruncated)

## [0.3.3] - 2026-10-04

- Wait now RESUMES instead of restarting: timeouts carry partial thinking/content (`QwenPartialError`), continuation re-sends the tail with `think:false` so Qwen continues without re-thinking from scratch
- Applies to both text and agentic modes (agentic pushes a continuation note into tool history); partial thinking kept in the final trace; dialog text updated

## [0.3.2] - 2026-10-04

- Live thinking in agentic mode: tool steps now stream (`stream:true`), thinking prints token-by-token instead of silence during 180s steps
- Skip is final: after user skips Qwen, Lead can no longer delegate back to Qwen — must finish with native tools (one chat note, then enforced every round)
- Fixed agentic Wait not extending the timeout (retried with the same timeout before)

## [0.3.1] - 2026-10-04

- Real collapsible "+ Thinking": renders as native `<details>` block (tags verified in VS Code's HTML allowlist, stable API only) in both text and agentic modes
- Simple path now also saves thinking + shows details/button at the end (was Output-log only)

## [0.3.0] - 2026-10-04

- Qwen can now use GitHub Copilot / VS Code tools: bridge sends a ranked subset of `vscode.lm.tools` schemas to Ollama and executes Qwen's calls via `vscode.lm.invokeTool` (same chat token)
- Approval chain per mutating call: Lead allows (extra Copilot call) -> deny stops it -> ask_user pops a dialog for the human; reads auto-run; unknown tools default to approval
- Agentic mode for real work (file tasks or delegate/discuss), fast text mode for plain opinions; auto-fallback to text if the local model can't tool-call
- Removed duplicated Node-based localTools.ts (Principle B: reuse Copilot tools); Qwen grounded with workspace file list via context.ts
- Fixed missing contributions: `ollama.thinkingCollapsed` setting + `showLastThinking` command now in package.json

## [0.2.8] - 2026-10-04

- Fixed Skip-then-quit: after user skips Qwen, Lead can no longer end the task with an apology/narration; skip message now orders real action
- Added tool-nudge guard (max 2): on file tasks with zero tool calls, plain-text or `final` endings are refused and the Lead is forced to emit a real tool call

## [0.2.7] - 2026-10-04

- Live token streaming for Qwen: switched Ollama from `stream:false` to `stream:true` (NDJSON), thinking streams as quote lines and answer streams raw token-by-token with throttled flush (400ms)
- Retry-safe headers (no duplicate `### Qwen` on Wait-retry), empty-line and thinking-only guards, live thinking capped at 4000 chars

## [0.2.6] - 2026-10-04

- Show Qwen thinking trace in chat: requests `think:true` from Ollama, reads `message.thinking` (fallback parses `<think>` tags in content), displays as a quote block under `**Thinking:**` before the answer
- New setting `ollama.showThinking` (default true); full trace always logged to Output; thinking hidden from Lead context to save tokens

## [0.2.5] - 2026-10-04

- Removed redundant "Waiting for Qwen (timeout ...)" chat line after choosing Wait

## [0.2.4] - 2026-10-04

- Fixed "CALL to create..." narration bug: lead now forbidden from narrating tool actions; file tasks get a mandatory inspect-write-verify workflow
- File-task detection (`wantsFileOps`): after Qwen drafts content, lead is forced to emit a REAL tool call instead of ending with narration or asking the user for content
- Track `toolsUsed` so post-Qwen and final prompts know whether anything was actually written

## [0.2.3] - 2026-10-04

- Qwen timeout now asks WAIT vs SKIP: Wait retries with a longer timeout (+120s each time, up to 30 min) so slow PCs can finish; Skip continues with Lead AI
- Timeout errors now report elapsed seconds and are distinguished from real cancellations

## [0.2.2] - 2026-10-04

- Show lead model header every reply + `@multi /models` lists Copilot models visible to the extension
- Handle transient Copilot routing errors ("No lowest priority node found (path: mie)", rate limits, overloads): retry without tools, then switch model once, instead of killing the chat
- Stream errors now covered by the same retry path (previously only sendRequest was wrapped)

## [0.2.1] - 2026-10-04

- Fixed "Auto mode needs a prompt" even with zero tools: detect Copilot "Auto" router pseudo-model and auto-switch to a concrete model (GPT-4o > GPT > Claude > other) following the Copilot model list
- Chat no longer dies on Auto: switches model once, then disables tools, then shows picker hint

## [0.2.0] - 2026-10-04

- Lead model AUTO: no more GPT hardcode, respects Chat model picker (GPT/Claude), label shows model name
- Qwen timeout asks user first: Retry Qwen / Skip (new `ollama.askBeforeSkip`, default true) for slow PCs
- Fixed `Auto mode needs a prompt...`: exclude prompt-router tools + retry without tools, never crashes the chat (new `enableTools` setting)
- Qwen is text-only by contract: lead must do file ops with native tools itself

## [0.1.0] - 2026-10-04

- Task-aware tool selection (max 64, ranked) instead of blind slice(0,128)
- GPT can answer directly in Markdown; JSON only required for Qwen delegation
- Qwen/Ollama failures degrade gracefully to GPT-only (no session crash)
- Per-tool error results fed back to GPT instead of aborting
- Clear errors for missing Copilot login, Ollama offline, model not found
- Added contributes.configuration so other users can set URL/model/timeout/maxRounds
- Rewrote README with install, settings, tests, troubleshooting