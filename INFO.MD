# Project Continuation Prompt — AI Copilot Bridge

## 1. Project Overview

You are working on a real VS Code extension project named **AI Copilot Bridge**.

Project path:
`D:\AI-Copilot-Bridge\ai-copilot-bridge`

The purpose of this project is to create a multi-agent coding assistant that connects GitHub Copilot's language model with a local AI model running through Ollama.

This is not a standalone chatbot and should not duplicate existing VS Code or GitHub Copilot tools.

The extension should act as an orchestration layer that allows a lead AI to collaborate with local AI models while reusing existing VS Code tools, MCP tools, terminal capabilities, and other available integrations.

## 2. Technology Stack

* VS Code Extension API
* TypeScript
* Node.js
* esbuild
* npm
* GitHub Copilot Language Model API
* Ollama local API
* Local model: `qwen3:4b`
* Ollama URL: `http://localhost:11434`
* Development environment: Windows
* VS Code version: `1.139.1`

The project was initially generated using `yo code`.

The extension runs through the VS Code Extension Development Host using F5.

## 3. Current Architecture

The intended architecture is:

USER
|
v
VS Code Chat Participant (@multi)
|
v
GitHub Copilot GPT — Lead AI / Boss
|
+---- Native VS Code / Copilot tools
|       |
|       +---- File operations
|       +---- Code search
|       +---- Terminal and execution tools
|       +---- MCP tools
|       +---- Other available tools
|
+---- Local AI through AI Copilot Bridge
|
v
Ollama / Qwen
|
v
Analysis / Review / Debugging
|
v
GitHub Copilot GPT
|
v
Final response to user

The GPT model is the lead agent and retains final decision-making authority.

Qwen is a local worker, reviewer, analyst, and coding assistant.

GPT must be able to decide whether to use local AI, native tools, both, or neither.

Do not force Qwen to run for every request.

## 4. Current Project Files

### `src/extension.ts`

Responsibilities:

* Register the Chat Participant.
* Handle incoming chat requests.
* Pass requests to the orchestrator.
* Handle cancellation and errors.
* Display responses to the user.

Current participant ID:

`ai-copilot-bridge.multi`

Current chat invocation:

`@multi <your request>`

The extension registers the participant through `vscode.chat.createChatParticipant()`.

The file imports `runAgent` from `./orchestrator`.

### `src/orchestrator.ts`

Responsibilities:

* Coordinate GPT and Qwen.
* Send requests to the GitHub Copilot language model.
* Handle tool calls.
* Invoke available VS Code tools through the VS Code API.
* Manage the GPT-to-Qwen interaction loop.
* Stream progress and responses to the user.
* Respect cancellation.
* Limit the number of collaboration rounds.

The orchestrator currently uses these concepts:

* `AgentAction`
* `BossDecision`
* `askGPT()`
* `executeTools()`
* `runAgent()`
* `extractDecision()`

The current design still uses JSON decisions with actions such as:

* `ask`
* `delegate`
* `discuss`
* `final`

This design may be replaced by a more natural tool-calling architecture later, but do not rewrite it until the current tool-calling flow has been tested and understood.

### `src/ollama.ts`

Responsibilities:

* Connect to the local Ollama server.
* Send prompts to the configured local model.
* Return the generated response.
* Support cancellation.
* Apply request timeouts.

Default configuration:

* URL: `http://localhost:11434`
* Model: `qwen3:4b`
* Timeout: `180000` milliseconds

Ollama endpoint:

`POST /api/chat`

The request uses `stream: false`.

### `package.json`

Important configuration:

* Extension name: `ai-copilot-bridge`
* Display name: `AI Copilot Bridge`
* Main entry: `./dist/extension.js`
* VS Code engine requirement: `^1.139.0`
* Chat participant ID: `ai-copilot-bridge.multi`

Settings include:

* `aiCopilotBridge.ollama.url`
* `aiCopilotBridge.ollama.model`
* `aiCopilotBridge.ollama.timeout`
* `aiCopilotBridge.maxRounds`

Do not change the participant ID unless you also update every corresponding reference.

## 5. Current Development Status

The project has been split into separate modules:

* `src/extension.ts`
* `src/orchestrator.ts`
* `src/ollama.ts`

Earlier, the simple `@multi` participant worked correctly and could return a response from GPT.

The GPT-to-Qwen-to-GPT collaboration flow also worked in an earlier version.

The user has successfully addressed several TypeScript issues during the refactor.

### Issue 1: LanguageModelTool generic type

The initial code incorrectly used `LanguageModelTool<T>` where `LanguageModelChatTool` was required.

This type mismatch was addressed during development.

When passing tools to `model.sendRequest()`, use the correct type expected by the installed VS Code API.

Do not confuse:

* `LanguageModelTool`
* `LanguageModelToolInformation`
* `LanguageModelChatTool`

They represent different concepts.

Inspect the installed VS Code typings when uncertain.

### Issue 2: Too many tools

The extension encountered:

`Error: Cannot have more than 128 tools per request.`

The original implementation attempted to send every item from `vscode.lm.tools` into the language model request.

This is not an acceptable final design.

Do not blindly expose every available tool to the model.

Instead:

* Inspect available tool names and schemas.
* Design an appropriate selection strategy.
* Respect the API limit.
* Avoid silently excluding important tools.
* Preserve compatibility with the installed VS Code version.

### Issue 3: Auto tool mode

The extension also encountered:

`Error: Auto mode needs a prompt or a command to route a request.`

The code previously used:

`vscode.LanguageModelChatToolMode.Auto`

The user was instructed to try omitting `toolMode` and passing only `tools` to `model.sendRequest()`.

The result of that latest test has not yet been confirmed.

**Do not assume that the native tool-calling workflow is working yet.**

First inspect the current source code and test the existing implementation.

## 6. Core Development Principles

### Principle A: GPT is the lead agent

GPT should make the final decisions.

Qwen should not automatically override GPT's conclusions.

GPT may:

* Use native tools.
* Ask Qwen for analysis.
* Request a code review from Qwen.
* Compare multiple approaches.
* Reject Qwen's suggestions.
* Ask Qwen to revise an analysis.
* Finish without using Qwen.

### Principle B: Reuse existing tools

Do not create duplicate tools for capabilities that already exist in VS Code, Copilot, or MCP.

Avoid creating unnecessary custom implementations of:

* File listing
* File reading
* Code searching
* Terminal execution
* File editing

Use the available VS Code tools whenever the API supports the desired operation.

### Principle C: Qwen should eventually become a callable tool

The long-term goal is to expose local AI as a tool that GPT can invoke when useful.

Conceptual interface:

`ask_local_ai`

Example input:

`{ "task": "Review this Python function for potential bugs" }`

The bridge should send the task to Ollama, receive the result, and return it to GPT.

The goal is for GPT to decide when to call Qwen, rather than relying on a rigid, forced sequence.

However, implement this only after the existing native tool flow is stable.

Use the VS Code extension APIs correctly. Do not assume that registering a tool in the extension automatically makes it available to a separate language model request. Verify the actual API behavior.

### Principle D: Reliable tool execution

For every tool call:

1. Inspect the requested tool name and input.
2. Use the correct invocation API.
3. Pass the appropriate tool invocation token when required.
4. Preserve the tool call ID and corresponding result.
5. Feed the result back into the model correctly.
6. Continue the model loop until it produces a final answer or cancellation occurs.

Do not claim a tool ran successfully unless it actually ran and returned a result.

### Principle E: Cancellation and errors

Support cancellation across:

* GPT requests
* Native tool calls
* Ollama requests

Do not continue unnecessary local model inference after cancellation.

Handle errors without crashing the Chat Participant.

### Principle F: User interface

Use clean, readable chat output.

Use headings such as:

`### GPT — Lead AI`

`### Qwen — Local AI`

Do not use emoji in the UI.

Do not display an unnecessary `FINAL` or `FINAL ANSWER` heading. The final response should simply appear as normal Markdown.

## 7. Immediate Next Steps

Follow this order. Do not skip ahead.

### Step 1 — Inspect the current source

Read:

* `src/extension.ts`
* `src/orchestrator.ts`
* `src/ollama.ts`
* `package.json`
* `tsconfig.json`
* `esbuild.js`

Check the actual current implementation before editing.

Do not assume that the source matches an older version of this prompt exactly.

### Step 2 — Verify compilation

Run:

`npm run compile`

Fix all compilation errors using the actual installed API typings.

Do not hide type problems using unnecessary `as unknown as` casts.

### Step 3 — Verify basic GPT responses

Launch the extension with F5.

In the Extension Development Host, test:

`@multi Explain what this extension does.`

Confirm that GPT can respond normally.

### Step 4 — Verify Ollama

Test:

`@multi Ask the local AI to explain the difference between TCP and UDP.`

Confirm that the request reaches Ollama and the local response is displayed.

Avoid unnecessary Qwen requests because local inference may be slow.

### Step 5 — Verify native tools

Test:

`@multi Inspect this workspace and identify the main project files.`

Verify whether GPT actually requests native tools, whether the bridge invokes them, and whether the returned results are passed back to GPT.

If native tools fail, diagnose the actual API issue before making further architectural changes.

Do not claim native tool support is complete merely because the extension compiles.

### Step 6 — Fix tool selection and limits

Inspect the tools available through the VS Code API.

Implement a sensible tool selection strategy that respects the 128-tool limit.

Do not rely on `.slice(0, 128)` as the final solution.

Prefer a task-aware strategy where appropriate, while keeping the implementation understandable and maintainable.

### Step 7 — Improve orchestration

After native tools are stable, allow GPT to choose whether to:

* Use a native tool.
* Request local AI analysis.
* Use multiple tools.
* Return a final response.

The desired workflow is dynamic rather than a fixed sequence.

### Step 8 — Add Qwen as a tool

Implement the local AI integration as a callable tool using the supported VS Code API, if the API permits the desired architecture.

Ensure that tool inputs and outputs are validated.

### Step 9 — Test real coding tasks

Use realistic tests such as:

* Explain an existing codebase.
* Find a bug in a source file.
* Review code for security issues.
* Propose a fix and explain why it works.
* Run tests through existing tools where available.
* Ask Qwen to independently review a proposed solution.

## 8. Development Rules

* Make incremental changes.
* Prefer minimal, targeted patches.
* Do not rewrite working files without a clear reason.
* Explain which file to change and why.
* Provide complete code blocks when replacing functions.
* Avoid unnecessary abstractions.
* Do not duplicate existing VS Code tools.
* Do not assume API capabilities without checking the installed types or official documentation.
* If an error occurs, identify its root cause before proposing another architecture.
* Test compilation after meaningful changes.
* Distinguish between compile-time success and runtime success.
* Do not claim a feature works before it has been tested.

## 9. Definition of Success

The final extension should provide a usable multi-agent coding assistant where:

1. The user sends a request through `@multi`.
2. GPT acts as the lead agent.
3. GPT uses native VS Code/Copilot/MCP tools when appropriate.
4. GPT can ask Qwen for independent analysis when useful.
5. Tool results return to GPT for evaluation.
6. GPT can continue working, call additional tools, or finish.
7. The user sees clear progress and a useful final answer.
8. The extension handles cancellation, errors, and tool limits reliably.
9. The project is maintainable and can be used by other developers.

## Your First Task

Start by inspecting the current project source and identifying the exact state of the tool-calling implementation.

Then:

1. Explain the current state briefly.
2. Identify the next blocking issue, if any.
3. Make the smallest correct change.
4. Run `npm run compile`.
5. Provide the exact test to run in the Extension Development Host.

Do not start by rewriting the entire project. Continue from the existing implementation.
