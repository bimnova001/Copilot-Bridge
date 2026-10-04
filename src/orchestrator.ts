import * as vscode from 'vscode';
import * as path from 'path';
import {
    askOllama,
    askOllamaToolStep,
    getOllamaConfig,
    LocalToolCall,
    LocalToolDef,
    OllamaResult,
    OllamaToolStep,
    parseTextToolCalls,
    QwenPartialError,
    stripTextToolCalls
} from './ollama';
import {
    formatWorkspaceContext,
    getWorkspaceContext,
    WorkspaceContext
} from './context';
import {
    getLocalToolDefs,
    runLocalTool
} from './localTools';

export type AgentAction =
    | 'ask'
    | 'delegate'
    | 'discuss'
    | 'final';

export interface BossDecision {
    action: AgentAction;
    message: string;
}

interface AgentTurnResult {
    text: string;
    toolCalls:
        vscode.LanguageModelToolCallPart[];
}

interface ThinkingSnapshot {
    text: string;
    model: string;
    at: number;
}

let lastThinking: ThinkingSnapshot = {
    text: '',
    model: '',
    at: 0
};

/** Last Qwen thinking trace (for the "View Qwen thinking" button). */
export function getLastThinking(): ThinkingSnapshot {
    return lastThinking;
}

const SYSTEM_PROMPT = `
You are the lead AI in a multi-agent coding system inside VS Code.
(You may be GPT, Claude, or another Copilot model — behave as the lead
regardless of which model you are.)

You are the BOSS. A local AI worker named Qwen is available as your text advisor.

You also have native VS Code / Copilot tools (file read, search, terminal, etc.).
Use them when they help. Do NOT simulate tool results yourself.

CRITICAL — Qwen CAN use workspace tools through this bridge:
- When you delegate real work (inspect, create/edit files, run checks),
  Qwen receives guaranteed BASIC tools (local_read/list/search/write/edit/run)
  plus a curated set of the same VS Code/Copilot tools — and CAN act.
- Approval is enforced by the bridge, not by trust:
  Qwen's READ-ONLY calls (read/search/list) run automatically;
  MUTATING calls (write/edit/delete/run) pause for YOUR approval per call
  (allow / deny / ask_user). If you say ask_user, the human confirms.
- So delegate freely, but stay responsible: verify important outcomes
  (file exists? tests pass?) with your own tools before reporting success.

How to respond on each turn:

1. If you need workspace information or must create/edit files,
   CALL a native tool now (the system will run it and give you
   the result, then ask you again).

2. If you want Qwen's help (second opinion, review, debugging help,
   alternative approach, draft content), return ONLY this JSON, no markdown fences:

{
  "action": "ask",
  "message": "<complete self-contained task for Qwen, including code/context>"
}

Valid actions: "ask", "delegate", "discuss", "final".
- ask: ask Qwen for an opinion (fast text-only mode, no tools).
- delegate: give Qwen a concrete task — Qwen executes it WITH tools.
- discuss: continue a technical discussion with Qwen.
- final: you have the final answer for the user.

3. Otherwise, answer the user directly in normal Markdown
   (no JSON wrapper needed). Plain Markdown is treated as the final answer.

LEAD-LIGHT WORKFLOW (follow strictly — goals: MINIMIZE your own token use, let Qwen carry the load):
1. UNDERSTAND FROM TEXT + SNAPSHOT: every request ships a workspace snapshot
   (root + file list) — read it instead of burning tool calls re-discovering
   what you were given. Call native tools ONLY for file CONTENT the snapshot lacks.
2. ORDER Qwen FULLY-SPECIFIED in ONE shot: exact relative paths, exact file
   content/commands, exact verification step. Qwen is hands, not brain.
   Bad: "inspect the workspace and create TEST.md".
   Good: "workspace root is d:/proj. Call local_write_file path=TEST.md
   content='hello'. Then local_list_dir path=. and confirm TEST.md is
   listed. Reply with the listing."
3. TRUST + VERIFY CHEAPLY: Qwen's tool results return to you as text — accept
   them, spot-check with your own tools ONLY when something smells off, then
   answer. User-explicit file writes skip your approval entirely by design.

Rules:
- Do not use Qwen for trivial questions you can answer alone.
- Do not expose chain-of-thought.
- For "final", put the full user-facing Markdown answer in "message".
- NEVER narrate tool actions. Forbidden phrases: "CALL to ...",
  "I will create the file", "Calling the tool now" as plain text.
  A tool is only real when you emit an actual tool call — text describing
  a call creates NOTHING on disk (the bridge may still pick up written JSON,
  but an emitted call is always preferred and faster).
- If the user asked for a file to be created/edited: do it directly with
  tools, or delegate ONCE fully-specified to Qwen — then verify. Do NOT end
  your turn with plain text saying you will do it — DO it.
`;

function extractDecision(
    text: string
): BossDecision | null {

    let cleaned = text.trim();

    cleaned = cleaned
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

    try {

        const parsed =
            JSON.parse(cleaned) as BossDecision;

        if (
            parsed &&
            typeof parsed.message === 'string' &&
            [
                'ask',
                'delegate',
                'discuss',
                'final'
            ].includes(parsed.action)
        ) {
            return parsed;
        }

    } catch {}

    const start =
        cleaned.indexOf('{');

    const end =
        cleaned.lastIndexOf('}');

    if (
        start !== -1 &&
        end > start
    ) {

        try {

            const parsed =
                JSON.parse(
                    cleaned.slice(
                        start,
                        end + 1
                    )
                ) as BossDecision;

            if (
                parsed &&
                typeof parsed.message === 'string' &&
                [
                    'ask',
                    'delegate',
                    'discuss',
                    'final'
                ].includes(parsed.action)
            ) {
                return parsed;
            }

        } catch {}
    }

    return null;
}

function isAutoModeError(error: unknown): boolean {
    const message =
        error instanceof Error
            ? `${error.message} ${String((error as Error).cause ?? '')}`
            : String(error);
    return /auto mode needs a prompt/i.test(message);
}

function isRetryableModelError(error: unknown): boolean {
    // Transient Copilot server-side routing errors. Examples seen live:
    // - "No lowest priority node found (path: mie)" — Copilot router hiccup
    // - rate limits / overloaded / timeouts
    // These are worth one automatic retry (possibly on another model),
    // not an instant chat-killing error.
    const message = (
        error instanceof Error
            ? `${error.message} ${String((error as Error).cause ?? '')}`
            : String(error)
    ).toLowerCase();
    return (
        /no lowest priority node found/.test(message) ||
        /rate limit|too many requests|429/.test(message) ||
        /overloaded|over capacity|try again|temporar/.test(message) ||
        /timed out|timeout|etimedout|econnreset|fetch failed/.test(message) ||
        /\b50[0-3]\b|server error|bad gateway|service unavailable/.test(message)
    );
}

function isAutoPseudoModel(model: vscode.LanguageModelChat): boolean {
    // VS Code / Copilot Chat has an "Auto" picker entry that is a router,
    // not a real LLM. It cannot be used via model.sendRequest() — it throws
    // "Auto mode needs a prompt or a command to route a request."
    // Detect it by id/name/family and replace with a concrete model.
    const parts = [
        model.id ?? '',
        model.name ?? '',
        model.family ?? ''
    ].map(s => s.toLowerCase());
    return parts.some(s => s === 'auto' || s.includes('auto'));
}

function pickConcreteModel(
    models: vscode.LanguageModelChat[],
    excludeId?: string
): vscode.LanguageModelChat | null {
    // Follow the GitHub Copilot model list: filter out the Auto router,
    // then prefer GPT-4o > GPT > Claude > anything else.
    const concrete = models.filter(
        m => !isAutoPseudoModel(m) && (!excludeId || m.id !== excludeId)
    );
    if (concrete.length === 0) {
        return null;
    }
    const rank = (m: vscode.LanguageModelChat): number => {
        const f = (m.family ?? '').toLowerCase();
        const n = (m.name ?? '').toLowerCase();
        const id = (m.id ?? '').toLowerCase();
        const s = `${f} ${n} ${id}`;
        if (/gpt-4o/.test(s)) { return 100; }
        if (/\bgpt\b|gpt-4|gpt-5|o1|o3/.test(s)) { return 80; }
        if (/claude/.test(s)) { return 70; }
        if (/gemini/.test(s)) { return 60; }
        return 10;
    };
    return [...concrete].sort((a, b) => rank(b) - rank(a))[0];
}

function getConfig<T>(key: string, defaultValue: T): T {
    return vscode.workspace
        .getConfiguration('aiCopilotBridge')
        .get<T>(key, defaultValue);
}

function wantsFileOps(prompt: string): boolean {
    // User explicitly wants a file created/edited, in English or Thai
    // (e.g. "write TEST.md", "สร้างไฟล์ test.md ให้หน่อย").
    const action = /creat|writ|edit|save|update|make|generat|สร้าง|เขียน|แก้|ลบไฟล์/i.test(prompt);
    const target = /file|\.md\b|\.txt\b|\.json\b|\.ts\b|\.js\b|\.py\b|test\.md|ไฟล์/i.test(prompt)
        || /in (the |this )?(project|workspace|repo|folder|directory)( path)?/i.test(prompt);
    return action && target;
}

function leadLabel(model: vscode.LanguageModelChat): string {
    // Auto: show whichever model the user picked (GPT, Claude, ...).
    const name = (model.name ?? '').trim();
    return name ? `Lead AI (${name})` : 'Lead AI';
}

const VERIFY_EXT = /\b[A-Za-z0-9_][\w\-.]*\.(md|txt|json|ts|js|tsx|jsx|py|java|cs|go|rs|html|css|yml|yaml|xml|sh|ps1|bat|sql)\b/gi;

/**
 * GOAL 2 mechanical check (zero lead tokens): filenames named in the request
 * are looked up on disk. Pass = lead can confirm immediately; fail = lead
 * must REDO instead of reporting success.
 */
async function verifyFilesOnDisk(
    prompt: string,
    workspaceRoot: string
): Promise<{ checked: string[]; missing: string[]; skipped: boolean }> {
    const names = new Set<string>();
    VERIFY_EXT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = VERIFY_EXT.exec(prompt)) !== null && names.size < 10) {
        names.add(m[0]);
    }
    if (names.size === 0 || !workspaceRoot) {
        return { checked: [], missing: [], skipped: true };
    }
    const checked: string[] = [];
    const missing: string[] = [];
    try {
        await Promise.race([
            (async () => {
                for (const name of names) {
                    const found = await vscode.workspace.findFiles(
                        `**/${name}`,
                        null,
                        1
                    );
                    (found.length > 0 ? checked : missing).push(name);
                }
            })(),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('verify-timeout')), 20000)
            )
        ]);
    } catch {
        for (const name of names) {
            if (!checked.includes(name) && !missing.includes(name)) {
                missing.push(name);
            }
        }
    }
    return { checked, missing, skipped: false };
}

/**
 * Qwen failed (often timeout on weak PCs). Ask the user:
 * WAIT = keep waiting for slow local inference (retry with longer timeout),
 * SKIP = skip Qwen and continue with the Lead AI.
 * Honors aiCopilotBridge.ollama.askBeforeSkip (false = auto-skip).
 */
async function askUserOnQwenFailure(
    message: string,
    waitCount: number,
    nextTimeoutSecs: number,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<'wait' | 'skip'> {

    const askBeforeSkip = getConfig<boolean>(
        'ollama.askBeforeSkip',
        true
    );

    if (!askBeforeSkip) {
        return 'skip';
    }

    stream.markdown(
        `Qwen (local AI) failed: ${message}\n\n` +
        `This often means Ollama is still loading the model or the PC is slow. ` +
        `You can **wait** (Qwen keeps thinking from where it stopped — no restart, ` +
        `longer ${nextTimeoutSecs}s timeout) ` +
        `or **skip** Qwen and continue with the Lead AI.\n`
    );

    // Show a real VS Code prompt so the user decides (weak-PC friendly).
    const SKIP = 'Skip Qwen, continue with Lead AI';
    const WAIT = waitCount === 0
        ? 'Wait, keep waiting for Qwen'
        : `Wait again for Qwen (${nextTimeoutSecs}s)`;

    const pick = await vscode.window.showWarningMessage(
        `Local AI (Qwen) failed: ${message}`,
        { modal: false },
        WAIT,
        SKIP
    );

    if (token.isCancellationRequested) {
        return 'skip';
    }

    if (pick === WAIT) {
        return 'wait';
    }

    return 'skip';
}

async function askGPT(
    model: vscode.LanguageModelChat,
    messages: vscode.LanguageModelChatMessage[],
    tools: vscode.LanguageModelChatTool[],
    token: vscode.CancellationToken
): Promise<AgentTurnResult> {

    // Consume one full request (sendRequest + stream). Stream errors
    // (e.g. transient Copilot routing failures) propagate to the caller.
    async function doRequest(
        activeTools: vscode.LanguageModelChatTool[]
    ): Promise<AgentTurnResult> {

        const response =
            await model.sendRequest(
                messages,
                activeTools.length > 0 ? { tools: activeTools } : {},
                token
            );

        const textParts: string[] = [];

        const toolCalls:
            vscode.LanguageModelToolCallPart[] = [];

        for await (
            const part of response.stream
        ) {

            if (
                part instanceof
                vscode.LanguageModelTextPart
            ) {

                textParts.push(
                    part.value
                );
            }

            else if (
                part instanceof
                vscode.LanguageModelToolCallPart
            ) {

                toolCalls.push(part);
            }
        }

        return {
            text: textParts.join(''),
            toolCalls
        };
    }

    try {

        return await doRequest(tools);

    } catch (error) {

        // Known VS Code/Copilot issue: with certain tool sets the
        // provider throws "Auto mode needs a prompt or a command
        // to route a request." Retry without tools so the chat
        // still works (answers from knowledge, no tools).
        // Same for transient stream failures: one no-tools retry
        // often succeeds without needing a model switch.
        if (
            (isAutoModeError(error) || isRetryableModelError(error)) &&
            tools.length > 0
        ) {

            console.error(
                '[AI Copilot Bridge] Model request failed, retrying without tools:',
                error
            );

            return await doRequest([]);
        }

        throw error;
    }
}

async function executeTools(
    toolCalls:
        vscode.LanguageModelToolCallPart[],
    request: vscode.ChatRequest,
    token: vscode.CancellationToken
): Promise<{
    results:
        vscode.LanguageModelToolResultPart[];
    ok: boolean[];
}> {

    const results:
        vscode.LanguageModelToolResultPart[] =
        [];

    const ok: boolean[] = [];

    for (
        const call of toolCalls
    ) {

        if (
            token.isCancellationRequested
        ) {
            break;
        }

        try {

            const result =
                await vscode.lm.invokeTool(
                    call.name,
                    {
                        input: call.input,
                        toolInvocationToken:
                            request.toolInvocationToken
                    },
                    token
                );

            results.push(
                new vscode.LanguageModelToolResultPart(
                    call.callId,
                    result.content
                )
            );

            ok.push(true);

        } catch (error) {

            console.error(
                `[AI Copilot Bridge] Tool "${call.name}" failed:`,
                error
            );

            const message =
                error instanceof Error
                    ? error.message
                    : String(error);

            results.push(
                new vscode.LanguageModelToolResultPart(
                    call.callId,
                    [
                        new vscode.LanguageModelTextPart(
                            `Tool "${call.name}" failed: ${message}`
                        )
                    ]
                )
            );

            ok.push(false);
        }
    }

    return { results, ok };
}

/** Short one-liner for showing a Copilot tool call in chat. */
function describeLeadCall(
    name: string,
    input: unknown
): string {
    let args = '';
    try {
        args = JSON.stringify(input ?? {}).slice(0, 160);
    } catch {
        args = '(unserializable args)';
    }
    return `${name}(${args})`;
}

/**
 * The lead sometimes WRITES a function call as JSON text instead of emitting
 * a real tool call (seen live: a `{"function":"local_write_file",...}` block
 * rendered as markdown while nothing ran). The bridge sweeps these up and
 * runs them — same runners, same visibility — instead of stalling.
 * Only exact names of tools actually handed to the lead are honored.
 */
function extractTextToolCalls(
    text: string,
    knownNames: Set<string>
): Array<{ name: string; input: object }> {

    const found: Array<{ name: string; input: object }> = [];

    const tryObject = (obj: unknown): void => {
        if (!obj || typeof obj !== 'object' || found.length >= 3) {
            return;
        }
        const rec = obj as Record<string, unknown>;
        const rawName = rec.function ?? rec.name ?? rec.tool;
        const rawInput = rec.arguments ?? rec.args ?? rec.parameters ?? rec.input;
        if (typeof rawName !== 'string' || !rawName) {
            return;
        }
        if (!rawInput || typeof rawInput !== 'object') {
            return;
        }
        if (!knownNames.has(rawName)) {
            return;
        }
        found.push({ name: rawName, input: rawInput as object });
    };

    // Fenced blocks first (```json ... ``` or ```tool ... ```).
    const fence = /```(?:json|tool)?\s*([\s\S]*?)```/gi;
    let m: RegExpExecArray | null;
    while ((m = fence.exec(text)) !== null && found.length < 3) {
        try {
            tryObject(JSON.parse(m[1].trim()));
        } catch {
            // Not JSON — ignore.
        }
    }

    // Bare balanced {...} objects mentioning a call shape.
    for (let i = 0; i < text.length && found.length < 3; i++) {
        if (text[i] !== '{') {
            continue;
        }
        let depth = 0;
        let inStr = false;
        let esc = false;
        for (let j = i; j < text.length && j < i + 4000; j++) {
            const ch = text[j];
            if (inStr) {
                if (esc) {
                    esc = false;
                } else if (ch === '\\') {
                    esc = true;
                } else if (ch === '"') {
                    inStr = false;
                }
                continue;
            }
            if (ch === '"') {
                inStr = true;
            } else if (ch === '{') {
                depth++;
            } else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    const slice = text.slice(i, j + 1);
                    if (/"(function|name|tool)"\s*:/.test(slice)) {
                        try {
                            tryObject(JSON.parse(slice));
                        } catch {
                            // Not JSON — ignore.
                        }
                    }
                    i = j;
                    break;
                }
            }
        }
    }

    // Dedupe identical calls (prose often repeats the block).
    const seen = new Set<string>();
    return found.filter(c => {
        const key = `${c.name}:${JSON.stringify(c.input)}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

/** Max tools per model request. VS Code limit is 128; keep margin. */
const MAX_TOOLS = 64;

// Exclude meta/prompt-router tools known to trigger
// "Auto mode needs a prompt or a command to route a request."
// Be careful NOT to exclude terminal commands (contain "command").
const TOOL_EXCLUDE = /^(copilot_prompt|run_prompt|agent_mode|chat_agent|subagent|think_tool|memory_tool)$/i;

function scoreTool(
    name: string,
    description: string,
    prompt: string
): number {

    const n = name.toLowerCase();
    const d = (description ?? '').toLowerCase();
    const p = prompt.toLowerCase();

    let score = 0;

    // Generally useful coding tools first.
    if (/read|file|open|edit|create|write/.test(n)) { score += 30; }
    if (/search|grep|find|lookup|codebase/.test(n)) { score += 25; }
    if (/terminal|run|execute|shell|command/.test(n)) { score += 20; }
    if (/vscode|workspace|document|symbol/.test(n)) { score += 10; }
    if (/copilot|edit|notebook/.test(n)) { score += 5; }

    // Deprioritize noisy or rarely useful tools.
    if (/playwright|browser|web|fetch/.test(n)) { score -= 5; }
    if (/test_|_test|debug|pylance|jupyter/.test(n) && !/test/.test(p)) { score -= 3; }

    // Task-aware boost: match tool keywords found in the user prompt.
    const keywords = [
        'read', 'file', 'search', 'find', 'grep',
        'edit', 'fix', 'terminal', 'run', 'test',
        'symbol', 'rename', 'debug'
    ];

    for (const kw of keywords) {
        if (p.includes(kw) && (n.includes(kw) || d.includes(kw))) {
            score += 15;
        }
    }

    return score;
}

function selectTools(
    prompt: string
): vscode.LanguageModelChatTool[] {

    const seen = new Set<string>();

    const scored = vscode.lm.tools
        .filter(tool => {
            if (!tool.name || seen.has(tool.name)) {
                return false;
            }
            if (TOOL_EXCLUDE.test(tool.name)) {
                return false;
            }
            seen.add(tool.name);
            return true;
        })
        .map(tool => ({
            tool,
            score: scoreTool(
                tool.name,
                tool.description ?? '',
                prompt
            )
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_TOOLS)
        .map(({ tool }) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema
        }));

    console.log(
        `[AI Copilot Bridge] Tools: ${vscode.lm.tools.length} available, ${scored.length} selected.`
    );

    return scored;
}

// ---------------------------------------------------------------------------
// Qwen on Copilot tools.
//
// YES — the local model can use GitHub Copilot / VS Code tools. Qwen itself
// only speaks HTTP to Ollama, so the bridge acts as hands: it sends a curated
// subset of vscode.lm.tools schemas to Ollama (native tool-calling), then
// executes Qwen's tool calls via vscode.lm.invokeTool with this chat request's
// toolInvocationToken and feeds results back. Small local models drown in 100+
// tools, so Qwen gets a small task-ranked subset (default 16), not everything.
//
// Approval (lead allows, user confirms when needed):
// - READ-ONLY calls (read/search/list) run automatically.
// - MUTATING calls (write/edit/delete/run/...) pause for the LEAD model:
//   allow = run it, deny = tell Qwen no, ask_user = pop a dialog for the human.
function buildQwenCopilotTools(
    prompt: string,
    max: number,
    fileTask: boolean
): LocalToolDef[] {

    const seen = new Set<string>();

    const ranked = vscode.lm.tools
        .filter(tool => {
            if (!tool.name || seen.has(tool.name)) {
                return false;
            }
            if (TOOL_EXCLUDE.test(tool.name)) {
                return false;
            }
            seen.add(tool.name);
            return true;
        })
        .map(tool => {
            const name = tool.name.toLowerCase();
            let score = scoreTool(
                tool.name,
                tool.description ?? '',
                prompt
            );
            // File tasks MUST have a writer: without this, generic ranking
            // can fill all slots with readers/searchers (or unrelated MCP
            // toys) and Qwen concludes "no file tool exists" — exactly the
            // TEST.md failure. Boost writers hard when files are involved.
            if (fileTask && /write|create|edit|apply|save/i.test(name)) {
                score += 100;
            }
            if (fileTask && /read|open|list|workspace/i.test(name)) {
                score += 20;
            }
            // Unrelated domains burn the small model's context and attention.
            if (/roblox|minecraft|playwright|browser|jupyter|notebook/i.test(name)) {
                score -= 40;
            }
            return { tool, score };
        })
        .sort((a, b) => b.score - a.score);

    // Guarantee: a file task with zero write-capable tools exposed is a
    // guaranteed failure — force-swap the best writer in if needed.
    if (
        fileTask &&
        !ranked
            .slice(0, Math.max(1, max))
            .some(({ tool }) => /write|create|edit|apply|save/i.test(tool.name))
    ) {
        const writer = ranked.find(({ tool }) =>
            /write|create|edit|apply|save/i.test(tool.name)
        );
        if (writer) {
            const idx = ranked.indexOf(writer);
            ranked.splice(idx, 1);
            ranked.splice(Math.max(0, max - 1), 0, writer);
            console.log(
                `[AI Copilot Bridge] Force-included writer tool for file task: ${writer.tool.name}`
            );
        } else {
            console.log(
                '[AI Copilot Bridge] WARNING: no write-capable Copilot tool found at all.'
            );
        }
    }

    const defs = ranked
        .slice(0, Math.max(1, max))
        .map(({ tool }) => ({
            type: 'function' as const,
            function: {
                name: tool.name,
                description: tool.description ?? tool.name,
                parameters: tool.inputSchema ?? {
                    type: 'object',
                    properties: {}
                }
            }
        }));

    console.log(
        `[AI Copilot Bridge] Qwen tools: ${vscode.lm.tools.length} available, ${defs.length} exposed.`
    );

    return defs;
}

/** True when a Copilot tool can change something (needs lead approval). Unknown tools default to mutating = safe. */
function isMutatingCopilotTool(
    name: string,
    description: string
): boolean {
    const s = `${name} ${description ?? ''}`.toLowerCase();
    if (/read|get_|list|show|search|find|grep|lookup|fetch_get|describe|explain|check_status|status/i.test(s)
        && !/write|edit|creat|delet|remov|renam|move|run|exec|terminal|shell|command|install|appl|save|update|set_|push|publish|merge|commit|delet/i.test(s)) {
        return false;
    }
    return true;
}

/** Expected argument keys for a tool (for corrective hints). */
function expectedKeys(def: LocalToolDef): string[] {
    const params = def.function.parameters as
        | { required?: unknown; properties?: unknown }
        | undefined;
    if (Array.isArray(params?.required)) {
        const req = params.required.filter(
            (k): k is string => typeof k === 'string'
        );
        if (req.length > 0) {
            return req;
        }
    }
    const props = params?.properties;
    if (props && typeof props === 'object') {
        return Object.keys(props as Record<string, unknown>).slice(0, 8);
    }
    return [];
}

/**
 * Free corrective intervention after the same tool is rejected twice in a
 * row: name the exact correct call instead of spending lead tokens or steps.
 */
function correctiveHint(
    callName: string,
    def: LocalToolDef | undefined
): string {
    if (callName === 'local_edit_file') {
        return (
            `STOP calling local_edit_file — same mistake twice. ` +
            `local_edit_file only changes text INSIDE an EXISTING file and needs ` +
            `{"path", "oldText", "newText"} (you passed dirPath-style keys — those belong to a different tool). ` +
            `If the task needs a NEW file, call local_write_file with ` +
            `{"path": "<relative file>", "content": "<full content>"} RIGHT NOW, no more deliberation. ` +
            `If editing, first local_read_file the file, then use its exact text as oldText.`
        );
    }
    if (callName === 'local_write_file') {
        return (
            `STOP — local_write_file keeps failing on arguments. ` +
            `It needs exactly {"path": "<relative file>", "content": "<full content>"}. ` +
            `Call it correctly NOW, no more deliberation.`
        );
    }
    const keys = def ? expectedKeys(def) : [];
    return (
        `STOP — "${callName}" was rejected twice in a row. ` +
        (keys.length > 0 ? `It needs keys: ${keys.join(', ')}. ` : ``) +
        `Check the tool list and call correctly NOW, or finish with a text summary.`
    );
}
/** Required arg keys missing from a call (cheap local check — no lead call spent). */
function missingRequiredArgs(
    def: LocalToolDef,
    args: unknown
): string[] {
    const params = def.function.parameters as
        | { required?: unknown }
        | undefined;
    const required = Array.isArray(params?.required)
        ? params.required.filter((k): k is string => typeof k === 'string')
        : [];
    if (required.length === 0) {
        return [];
    }
    const rec = (args ?? {}) as Record<string, unknown>;
    return required.filter(k => {
        const v = rec[k];
        return v === undefined || v === null || v === '';
    });
}

function describeCopilotCall(call: LocalToolCall): string {
    let args = '';
    try {
        args = JSON.stringify(call.args ?? {}).slice(0, 160);
    } catch {
        args = '(unserializable args)';
    }
    return `${call.name}(${args})`;
}

function copilotToolResultToString(
    result: vscode.LanguageModelToolResult
): string {
    const parts: string[] = [];
    for (const part of result.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
            parts.push(part.value);
        } else {
            parts.push('[non-text result content omitted]');
        }
    }
    const text = parts.join('\n').trim();
    return text || '(tool returned no text)';
}

type ApprovalDecision = 'allow' | 'deny' | 'ask_user';

function parseApproval(text: string): {
    decision: ApprovalDecision;
    reason: string;
} {
    const cleaned = text.trim();
    try {
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start !== -1 && end > start) {
            const parsed = JSON.parse(
                cleaned.slice(start, end + 1)
            ) as { decision?: unknown; reason?: unknown };
            const d = String(parsed.decision ?? '').toLowerCase();
            const r = typeof parsed.reason === 'string'
                ? parsed.reason.slice(0, 200)
                : '';
            if (d === 'allow' || d === 'deny' || d === 'ask_user') {
                return { decision: d, reason: r || '(no reason)' };
            }
        }
    } catch {
        // Fall through to keyword sniffing.
    }
    const low = cleaned.toLowerCase();
    if (low.includes('ask_user')) {
        return { decision: 'ask_user', reason: cleaned.slice(0, 200) };
    }
    if (low.includes('deny')) {
        return { decision: 'deny', reason: cleaned.slice(0, 200) };
    }
    if (low.includes('allow')) {
        return { decision: 'allow', reason: cleaned.slice(0, 200) };
    }
    // Safe default: a confused gate means the human decides.
    return { decision: 'ask_user', reason: 'Lead gave no clear decision.' };
}

/** Ask the LEAD model whether Qwen may run one mutating tool call. */
async function askLeadApproval(
    model: vscode.LanguageModelChat,
    userRequest: string,
    qwenTask: string,
    callDesc: string,
    token: vscode.CancellationToken,
    toolSchema?: string
): Promise<{ decision: ApprovalDecision; reason: string }> {

    const messages = [
        vscode.LanguageModelChatMessage.User(
            `You are the policy gate for Qwen, a local worker AI with sandboxed Copilot tools.

USER REQUEST:
${userRequest}

QWEN'S CURRENT TASK:
${qwenTask}

QWEN PROPOSES:
${callDesc}
${toolSchema ? `
TOOL ARGUMENT SCHEMA (exact keys Qwen must use):
${toolSchema}
` : ''}
Reply with ONLY JSON: {"decision": "allow | deny | ask_user", "reason": "<10 words>"}
- allow: safe and within the user's request.
- deny: dangerous, out of scope, or wrong arguments (check keys against the schema above).
- ask_user: destructive, irreversible, or ambiguous — a human must confirm.
Overwriting existing files and shell commands usually need ask_user unless clearly requested.`
        )
    ];

    try {

        const turn = await askGPT(model, messages, [], token);
        return parseApproval(turn.text);

    } catch (error) {

        console.error(
            '[AI Copilot Bridge] Lead approval failed, deferring to user:',
            error
        );

        return {
            decision: 'ask_user',
            reason: 'Lead unreachable, human decides.'
        };
    }
}

/** Cheap confusion signals: small models ramble instead of saying "help". */
const STUCK_RE = /stuck|not sure|don't know|dont know|do not know|confus|unclear|need help|what should|which tool|should i (use|call)|i['’]m (not|unsure)|no idea|unsure|hmm+/i;

function qwenLooksStuck(thinking: string, content: string): boolean {
    return STUCK_RE.test(`${thinking}\n${content}`);
}

/**
 * Qwen is confused: ask the LEAD for a 1-2 sentence decisive directive
 * (exact next tool call). The lead reviews / unblocks; Qwen stays hands.
 */
/** Compact schemas so the lead's directives use exact argument keys. */
function compactSchemas(allTools: LocalToolDef[]): string {
    return allTools
        .map(t => {
            const params = JSON.stringify(
                (t.function.parameters ?? {}) as object
            );
            const short = params.length > 300
                ? params.slice(0, 300) + '…'
                : params;
            return `- ${t.function.name}${short}`;
        })
        .join('\n');
}

async function askLeadGuidance(
    model: vscode.LanguageModelChat,
    task: string,
    thinkingTail: string,
    contentTail: string,
    toolNames: string,
    token: vscode.CancellationToken,
    toolSchemas?: string
): Promise<string | null> {

    const messages = [
        vscode.LanguageModelChatMessage.User(
            `Qwen (local worker, tools: ${toolNames}) is stuck on this task:\n${task}\n\n` +
            `Its confused thinking (tail):\n${thinkingTail.slice(-1200)}\n\n` +
            `Its last words:\n${contentTail.slice(-800)}\n\n` +
            (toolSchemas
                ? `EXACT argument schemas (use these keys, no invented keys):\n${toolSchemas}\n\n`
                : ``) +
            `Reply with 1-2 sentences: the EXACT next tool call (name + arguments, keys per schema above) it must make, ` +
            `or the direct answer if no tool is needed. Be decisive, no questions back.`
        )
    ];

    try {

        const turn = await askGPT(model, messages, [], token);
        const text = turn.text.trim();
        return text || null;

    } catch (error) {

        console.error(
            '[AI Copilot Bridge] Lead guidance failed:',
            error
        );

        return null;
    }
}

/** The lead said this tool needs a human: pop a VS Code dialog. */
async function askUserToolApproval(
    callDesc: string,
    reason: string,
    token: vscode.CancellationToken
): Promise<boolean> {

    const ALLOW = 'Allow once';
    const DENY = 'Deny';

    const pick = await vscode.window.showWarningMessage(
        `Qwen (local AI) wants to run: ${callDesc}\nLead says human must confirm: ${reason}`,
        { modal: false },
        ALLOW,
        DENY
    );

    if (token.isCancellationRequested) {
        return false;
    }

    return pick === ALLOW;
}

interface QwenAgentSuccess {
    ok: true;
    value: OllamaResult;
    toolsRan: number;
}

interface QwenAgentFailure {
    ok: false;
    error: string;
}

/**
 * GOAL 1 fast-path (saves a whole lead call): when the USER explicitly asked
 * for a NEW file ("create test.md with hello"), Qwen creating exactly that
 * file needs no lead approval — the human already authorized it. Overwrites
 * of existing files still go through the lead gate.
 */
async function isUserAuthorizedFileWrite(
    requestPrompt: string,
    call: LocalToolCall,
    workspaceRoot: string
): Promise<{ ok: boolean; reason: string }> {

    if (call.name !== 'local_write_file') {
        return { ok: false, reason: 'not a basic file write' };
    }

    const args = (call.args ?? {}) as Record<string, unknown>;
    const rel = typeof args.path === 'string' ? args.path : '';

    if (!rel) {
        return { ok: false, reason: 'missing path' };
    }

    const base = rel.split(/[\\/]/).pop()?.toLowerCase() ?? '';

    if (!base || !requestPrompt.toLowerCase().includes(base)) {
        return { ok: false, reason: 'file not named in the user request' };
    }

    if (!workspaceRoot) {
        return { ok: false, reason: 'no workspace' };
    }

    try {
        await vscode.workspace.fs.stat(
            vscode.Uri.file(path.join(workspaceRoot, rel))
        );
        return {
            ok: false,
            reason: `"${rel}" already exists — overwriting needs approval`
        };
    } catch {
        return { ok: true, reason: 'user explicitly requested this new file' };
    }
}

/**
 * Run Qwen as an AGENT on Copilot tools: send tool schemas to Ollama, execute
 * Qwen's tool calls via vscode.lm.invokeTool (lead-gated approval for
 * mutations, user dialog when the lead says ask_user), feed results back until
 * Qwen answers in text or the step budget runs out.
 */
async function runQwenAgent(
    opts: {
        task: string;
        userRequest: string;
        lead: string;
        model: vscode.LanguageModelChat;
        request: vscode.ChatRequest;
        stream: vscode.ChatResponseStream;
        token: vscode.CancellationToken;
        fileTask: boolean;
    }
): Promise<QwenAgentSuccess | QwenAgentFailure> {

    const {
        task, userRequest, lead, model,
        request, stream, token
    } = opts;

    const maxSteps = getConfig<number>('qwenMaxToolSteps', 8);
    const maxTools = getConfig<number>('qwenMaxTools', 8);
    const maxTokens = getConfig<number>('qwenMaxTokensPerStep', 2000);
    // Agentic thinking OFF by default: qwen3 burns the whole token budget
    // deliberating and dies before acting. Hands act, lead reviews.
    // (Text-mode Q&A keeps full thinking.)
    const agentThink = getConfig<boolean>('qwenAgentThink', false);
    let stepTimeout = getConfig<number>('ollama.timeout', 180000);
    const WAIT_STEP_MS = 120000;
    const MAX_TIMEOUT_MS = 1800000;
    const ollamaModel = getOllamaConfig().model;
    const showThinkingLive = getConfig<boolean>('ollama.showThinking', true);

    const tools = buildQwenCopilotTools(
        `${userRequest} ${task}`,
        maxTools,
        opts.fileTask
    );

    const ws = await Promise.race([
        getWorkspaceContext(),
        new Promise<WorkspaceContext>((_, reject) =>
            setTimeout(
                () => reject(new Error('Workspace scan timed out.')),
                15000
            )
        )
    ]);
    const root = ws.workspacePath;

    // Built-in BASIC tools: always present when a workspace is open, so
    // read/write works even on machines with zero file-writing Copilot
    // tools registered. Copilot tools stay as the rich extra set.
    const localDefs = root
        ? getLocalToolDefs().filter(
            d => !tools.some(t => t.function.name === d.function.name)
        )
        : [];

    // File tasks: drop Copilot tools that duplicate the basics (create/write/
    // edit file). Overlapping choices paralyze the small model ("which write
    // tool?") — basics are guaranteed and approval-gated, so they win.
    // Skipped when there are no local tools (no workspace).
    const copilotDefs =
        opts.fileTask && localDefs.length > 0
            ? tools.filter(
                t => !/create_?file|new_?file|write_?file|edit_?file|make_?file/i.test(
                    t.function.name
                )
            )
            : tools;

    const allTools = [...localDefs, ...copilotDefs];

    if (allTools.length === 0) {
        return {
            ok: false,
            error: 'No tools at all available to Qwen (no workspace, no Copilot tools).'
        };
    }

    const system =
        `You are Qwen, a local worker AI with workspace tools provided through a bridge. ` +
        `The lead AI (${lead}) delegated you a task. ` +
        `Use the tools when you need workspace facts or must create/edit files; ` +
        `paths are relative to the workspace root. ` +
        `Read-only calls run freely; mutating calls need approval (you will be told the verdict). ` +
        `When the task is done, reply with TEXT ONLY (no more tool calls): a concise summary of what you did plus the key content. ` +
        `Do not claim final authority.` +
        ` Be concise throughout: short reasoning, act with tools fast, no long essays.` +
        ` REASONING IS DISABLED for speed — do not deliberate, do not weigh options, do not re-derive givens. ` +
        `Output at most one short plan sentence, then the tool block(s) IMMEDIATELY. ` +
        `If you are unsure, output your one-sentence confusion and STOP (no tool block) — the lead AI will guide you. ` +
        `The lead reviews everything you do, so act — perfection is not required.` +
        `\n\nGUARANTEED BASIC TOOLS (always work — prefer these for file operations):\n` +
        localDefs.map(t => `- ${t.function.name}: ${t.function.description}`).join('\n') +
        `\n\nEXTRA COPILOT TOOLS (also callable):\n` +
        tools.map(t => `- ${t.function.name}: ${t.function.description}`).join('\n') +
        `\n\nCall a tool when the task needs it. Never claim a needed tool does not exist — the BASIC list above always works.` +
        `\n\nHOW TO CALL (do EXACTLY this — one fenced block per call, multiple blocks run in order):\n` +
        '```tool\n' +
        '{"name": "local_write_file", "args": {"path": "TEST.md", "content": "hello"}}\n' +
        '```\n' +
        `Call NOW — never describe calls in prose, never ask for permission in text (approvals arrive as tool results). ` +
        `A message with no tool block means you are DONE: write the final TEXT summary instead.`;

    const history: any[] = [
        {
            role: 'user',
            content:
                `TASK:\n${task}\n\n` +
                `USER REQUEST:\n${userRequest}\n\n` +
                `${formatWorkspaceContext(ws, 60)}\n\n` +
                `Finish with a text summary when done.`
        }
    ];

    stream.markdown(`### Qwen (${ollamaModel}) — Local AI\n\n`);
    stream.markdown(
        `> Agentic mode: ${localDefs.length} basic (${localDefs.map(t => t.function.name).join(', ')}) + ` +
        `${copilotDefs.length} Copilot (${copilotDefs.map(t => t.function.name).join(', ') || 'none'})\n` +
        `> Reads auto-run, writes/commands need Lead approval` +
        (agentThink ? `.\n\n` : `, thinking off for speed (Lead reviews all actions).\n\n`)
    );
    stream.markdown(
        `> Orders received — starting: ${task.slice(0, 200)}${task.length > 200 ? '…' : ''}\n\n`
    );
    if (showThinkingLive && agentThink) {
        stream.markdown(`**Thinking (live):**\n\n`);
    }

    let thinkingAll = '';
    let lastContent = '';
    let toolsRan = 0;
    // Consecutive same-tool rejections (unknown tool / bad args). At 2 in a
    // row the bridge intervenes with a corrective hint (free) instead of
    // letting Qwen burn all 8 steps on the same mistake (seen live: 8x
    // local_edit_file with dirPath keys, file never created).
    let rejectStreak: { tool: string; count: number } = { tool: '', count: 0 };
    // First network call also loads the model (zero tokens for minutes on
    // slow PCs) — one-time idle bonus so load time never kills step 1.
    let firstStepLoadBonus = true;
    const FIRST_LOAD_BONUS_MS = 120000;
    // Lead rescues confused Qwen (max 2 per agent run — each is a Copilot call).
    let guidanceUsed = 0;
    const MAX_LEAD_GUIDANCE = 2;

    // Track consecutive same-tool rejections. Returns true exactly when the
    // count hits 2 in a row = time for a free corrective intervention.
    const noteRejection = (toolName: string): boolean => {
        if (rejectStreak.tool === toolName) {
            rejectStreak.count++;
        } else {
            rejectStreak = { tool: toolName, count: 1 };
        }
        return rejectStreak.count === 2;
    };

    for (let step = 1; step <= maxSteps; step++) {

        if (token.isCancellationRequested) {
            return { ok: false, error: 'cancelled' };
        }

        let s: OllamaToolStep;

        // Live thinking printer is per-step (fresh counters each step).
        const liveThinking = createThinkingLivePrinter(stream);
        // One automatic Lead rescue per step (no user click yet).
        let stepAutoGuided = false;

        stream.progress(`Qwen working — step ${step}/${maxSteps}...`);

        try {

            s = await askOllamaToolStep(
                system,
                history,
                token,
                stepTimeout + (firstStepLoadBonus ? FIRST_LOAD_BONUS_MS : 0),
                allTools,
                showThinkingLive && agentThink
                    ? (thinking) => liveThinking.push(thinking, false)
                    : undefined,
                agentThink,
                maxTokens
            );
            firstStepLoadBonus = false;

            if (showThinkingLive && agentThink) {
                liveThinking.push(s.thinking, true);
                stream.markdown(`\n`);
            }

        } catch (error) {

            if (token.isCancellationRequested) {
                return { ok: false, error: 'cancelled' };
            }

            const message =
                error instanceof Error ? error.message : String(error);

            console.error('[AI Copilot Bridge] Qwen agent step failed:', error);

            // FIRST timeout on a step: don't bother the user yet — the step
            // produced rambling thinking but no tool call, so get a DIRECT
            // ORDER from the Lead and retry the same step immediately.
            // User dialog (wait/skip) only appears if this also fails.
            if (
                !stepAutoGuided &&
                error instanceof QwenPartialError &&
                guidanceUsed < MAX_LEAD_GUIDANCE &&
                (error.partialThinking.trim() || error.partialContent.trim())
            ) {
                stepAutoGuided = true;
                guidanceUsed++;
                if (error.partialThinking.trim()) {
                    thinkingAll += error.partialThinking.trim() + '\n';
                }
                stream.markdown(`> Qwen is rambling without acting — asking Lead for a direct order...\n\n`);
                const order = await askLeadGuidance(
                    model,
                    task,
                    error.partialThinking,
                    error.partialContent,
                    allTools.map(t => t.function.name).join(', '),
                    token,
                    compactSchemas(allTools)
                );
                if (token.isCancellationRequested) {
                    return { ok: false, error: 'cancelled' };
                }
                if (order) {
                    history.push({
                        role: 'user',
                        content:
                            `LEAD DIRECT ORDER — obey immediately: call the specified tool NOW ` +
                            `with the given arguments, no more deliberation:\n${order}\n\n` +
                            `(Continuing your partial work — do not restart, do not repeat.)`
                    });
                    stream.markdown(`> Lead order: ${order.slice(0, 400)}\n\n`);
                    step--;
                    continue;
                }
                // Order failed: fall through to the user dialog below.
            }

            // Partial thinking was already streamed live — keep it for the
            // final trace so a timed-out step doesn't lose its reasoning.
            if (
                error instanceof QwenPartialError &&
                error.partialThinking.trim()
            ) {
                thinkingAll += error.partialThinking.trim() + '\n';
            }

            const nextTimeout = Math.min(
                stepTimeout + WAIT_STEP_MS,
                MAX_TIMEOUT_MS
            );

            const choice = await askUserOnQwenFailure(
                message,
                0,
                Math.round(nextTimeout / 1000),
                stream,
                token
            );

            if (choice === 'wait') {
                stepTimeout = nextTimeout;
                // Resume, don't restart: feed back what Qwen already produced
                // (reasoning + answer tails) and let it KEEP THINKING from
                // there, briefly, then continue the step.
                if (
                    error instanceof QwenPartialError &&
                    (error.partialContent.trim() || error.partialThinking.trim())
                ) {
                    history.push({
                        role: 'user',
                        content: buildResumeNote(
                            error.partialThinking,
                            error.partialContent
                        )
                    });
                    stream.markdown(
                        `\n*(continuing step ${step} from where Qwen stopped — thinking continues, no restart, timeout ${Math.round(stepTimeout / 1000)}s)*\n\n`
                    );
                } else {
                    stream.progress(`Qwen is working (retrying step ${step}, timeout ${Math.round(stepTimeout / 1000)}s)...`);
                }
                step--;
                continue;
            }

            return { ok: false, error: message };
        }

        if (s.thinking.trim()) {
            thinkingAll += s.thinking.trim() + '\n';
        }

        // Native tool_calls first; fenced ```tool blocks as the reliable
        // fallback — small local models often NEVER emit native calls but
        // WILL write the exact block format when told how.
        const textCalls = parseTextToolCalls(s.content);
        const effCalls = s.toolCalls.length > 0 ? s.toolCalls : textCalls;
        const effRaw = s.toolCalls.length > 0
            ? s.rawToolCalls
            : textCalls.map(c => ({
                function: { name: c.name, arguments: c.args }
            }));

        if (textCalls.length > 0 && s.toolCalls.length === 0) {
            stream.markdown(`> Qwen: ${textCalls.length} tool call(s) via text format\n\n`);
        }

        history.push({
            role: 'assistant',
            content: s.content,
            tool_calls: effRaw
        });

        // Visibility: agentic step prose is otherwise invisible (only tool
        // lines show), so confusion/stalls hide. Surface short step text.
        {
            const stepText = stripTextToolCalls(s.content).trim();
            if (stepText) {
                const shown = stepText.length > 600
                    ? stepText.slice(0, 600).trim() + '…'
                    : stepText;
                stream.markdown(
                    shown.split('\n').map(l => `> ${l}`).join('\n') + `\n\n`
                );
            }
        }

        if (effCalls.length === 0) {
            lastContent = stripTextToolCalls(s.content) || s.content.trim();

            // No tool call: either Qwen is done (final summary) or confused.
            // Confused + nothing done yet (esp. file tasks with zero tool
            // calls) -> let the LEAD review and give an exact directive
            // instead of letting Qwen ramble for another 180s.
            const stuck =
                qwenLooksStuck(s.thinking, s.content) ||
                (opts.fileTask && toolsRan === 0);

            if (stuck && guidanceUsed < MAX_LEAD_GUIDANCE) {
                guidanceUsed++;
                stream.markdown(`> Qwen looks stuck — asking Lead for guidance...\n\n`);
                const guidance = await askLeadGuidance(
                    model,
                    task,
                    s.thinking,
                    s.content,
                    allTools.map(t => t.function.name).join(', '),
                    token,
                    compactSchemas(allTools)
                );
                if (token.isCancellationRequested) {
                    return { ok: false, error: 'cancelled' };
                }
                if (guidance) {
                    history.push({
                        role: 'user',
                        content:
                            `LEAD GUIDANCE — follow it exactly, then continue ` +
                            `(call the tool, do not deliberate):\n${guidance}`
                    });
                    stream.markdown(`> Lead guidance: ${guidance.slice(0, 400)}\n\n`);
                    step--;
                    continue;
                }
                // Guidance failed: fall through and finish with what we have.
            }

            break;
        }

        for (const call of effCalls) {

            if (token.isCancellationRequested) {
                return { ok: false, error: 'cancelled' };
            }

            const desc = describeCopilotCall(call);
            const def = allTools.find(
                t => t.function.name === call.name
            );

            if (!def) {
                history.push({
                    role: 'tool',
                    content:
                        `Unknown tool "${call.name}". Available: ` +
                        allTools.map(t => t.function.name).join(', ')
                });
                stream.markdown(`> Qwen: unknown tool "${call.name}" — rejected\n\n`);
                if (noteRejection(call.name)) {
                    const fix = correctiveHint(call.name, undefined);
                    history.push({ role: 'user', content: fix });
                    stream.markdown(`> Bridge corrective hint sent.\n\n`);
                }
                continue;
            }

            // Cheap shape check BEFORE any approval round-trip: malformed
            // calls (e.g. file content stuffed into local_run) are rejected
            // with a hint, spending zero lead tokens and zero dialogs.
            const missing = missingRequiredArgs(def, call.args);

            if (missing.length > 0) {
                const rec = (call.args ?? {}) as Record<string, unknown>;
                const keys = Object.keys(rec);
                let hint =
                    `Rejected without approval: missing required argument(s) ` +
                    `${missing.join(', ')} for "${call.name}" ` +
                    `(got keys: ${keys.join(', ') || 'none'}).`;
                if (
                    call.name === 'local_run' &&
                    ('path' in rec || 'content' in rec)
                ) {
                    hint +=
                        ` You passed file-writing arguments — did you mean ` +
                        `local_write_file with {"path", "content"}?`;
                }
                history.push({ role: 'tool', content: hint });
                stream.markdown(`> Qwen: ${desc} — rejected (${hint})\n\n`);
                if (noteRejection(call.name)) {
                    const fix = correctiveHint(call.name, def);
                    history.push({ role: 'user', content: fix });
                    stream.markdown(`> Bridge corrective hint sent.\n\n`);
                }
                continue;
            }

            const runIt = async (): Promise<string> => {
                // Built-in basics run locally (sandboxed); everything else
                // goes through the Copilot tool system with this chat's token.
                if (call.name.startsWith('local_')) {
                    const out = await runLocalTool(call, root);
                    toolsRan++;
                    rejectStreak = { tool: '', count: 0 };
                    return out.slice(0, 8000);
                }
                const res = await vscode.lm.invokeTool(
                    call.name,
                    {
                        input: (call.args ?? {}) as object,
                        toolInvocationToken: request.toolInvocationToken
                    },
                    token
                );
                toolsRan++;
                rejectStreak = { tool: '', count: 0 };
                return copilotToolResultToString(res).slice(0, 8000);
            };

            // READ-ONLY: lead pre-allows, run immediately.
            if (!isMutatingCopilotTool(call.name, def.function.description)) {
                try {
                    const out = await runIt();
                    history.push({ role: 'tool', content: out });
                    stream.markdown(`> Qwen: ${desc} — ok\n\n`);
                } catch (error) {
                    const message =
                        error instanceof Error ? error.message : String(error);
                    history.push({
                        role: 'tool',
                        content: `Tool failed: ${message}`
                    });
                    stream.markdown(`> Qwen: ${desc} — failed: ${message}\n\n`);
                }
                continue;
            }

            // MUTATING: user-explicit new files skip the lead entirely
            // (GOAL 1: zero lead tokens spent); everything else is gated.
            const authorized = await isUserAuthorizedFileWrite(
                userRequest,
                call,
                root
            );

            if (authorized.ok) {
                try {
                    const out = await runIt();
                    history.push({ role: 'tool', content: out });
                    stream.markdown(
                        `> Qwen: ${desc} — user-authorized, done (no Lead call spent)\n\n`
                    );
                } catch (error) {
                    const message =
                        error instanceof Error ? error.message : String(error);
                    history.push({
                        role: 'tool',
                        content: `Tool failed: ${message}`
                    });
                    stream.markdown(`> Qwen: ${desc} — failed: ${message}\n\n`);
                }
                continue;
            }

            // MUTATING: lead allows; lead says ask_user -> ask the human.
            stream.markdown(`> Qwen wants **${desc}** — asking Lead...\n\n`);

            const approval = await askLeadApproval(
                model,
                userRequest,
                task,
                desc,
                token,
                JSON.stringify({
                    name: def.function.name,
                    description: def.function.description,
                    parameters: def.function.parameters
                }).slice(0, 800)
            );

            if (approval.decision === 'deny') {
                history.push({
                    role: 'tool',
                    content:
                        `DENIED by lead: ${approval.reason}. ` +
                        `Do something else or finish with what you have.`
                });
                stream.markdown(
                    `> Qwen: ${desc} — denied by Lead (${approval.reason})\n\n`
                );
                continue;
            }

            if (approval.decision === 'ask_user') {
                const allowed = await askUserToolApproval(
                    desc,
                    approval.reason,
                    token
                );
                if (!allowed) {
                    history.push({
                        role: 'tool',
                        content:
                            'DENIED by user. Do something else or finish with what you have.'
                    });
                    stream.markdown(`> Qwen: ${desc} — denied by you\n\n`);
                    continue;
                }
                try {
                    const out = await runIt();
                    history.push({ role: 'tool', content: out });
                    stream.markdown(`> Qwen: ${desc} — approved by you, done\n\n`);
                } catch (error) {
                    const message =
                        error instanceof Error ? error.message : String(error);
                    history.push({
                        role: 'tool',
                        content: `Tool failed: ${message}`
                    });
                    stream.markdown(`> Qwen: ${desc} — failed: ${message}\n\n`);
                }
                continue;
            }

            try {
                const out = await runIt();
                history.push({ role: 'tool', content: out });
                stream.markdown(`> Qwen: ${desc} — approved by Lead, done\n\n`);
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);
                history.push({
                    role: 'tool',
                    content: `Tool failed: ${message}`
                });
                stream.markdown(`> Qwen: ${desc} — failed: ${message}\n\n`);
            }
        }
    }

    let content = lastContent;

    if (!content.trim()) {
        // Budget burned with no summary (seen live in T2): spend ONE cheap
        // no-tools turn to extract a closing summary instead of a dead note.
        stream.markdown(`> Qwen used its step budget — asking for a closing summary...\n\n`);
        try {
            const closing = await askOllamaToolStep(
                'You are Qwen. Summarize work already done in this task: what was accomplished + key results. TEXT ONLY, no tools, 5 sentences max.',
                [
                    ...history,
                    {
                        role: 'user',
                        content: 'Step budget exhausted. Write the final summary NOW (text only, no tool calls).'
                    }
                ],
                token,
                stepTimeout,
                [],
                undefined,
                false,
                1000
            );
            content = stripTextToolCalls(closing.content).trim() ||
                closing.thinking.trim();
        } catch (error) {
            console.error(
                '[AI Copilot Bridge] Qwen closing summary failed:',
                error
            );
        }
    }

    if (token.isCancellationRequested) {
        return { ok: false, error: 'cancelled' };
    }

    if (!content.trim()) {
        content = '(Qwen used its step budget without a final summary.)';
    }

    const thinking = thinkingAll.trim();

    lastThinking = { text: thinking, model: ollamaModel, at: Date.now() };
    console.log(
        `[AI Copilot Bridge] Qwen agent thinking (${thinking.length} chars):\n${thinking}`
    );

    showQwenFinal(stream, thinking, content);

    return {
        ok: true,
        value: { content, thinking },
        toolsRan
    };
}

/**
 * Collapsible "+ Thinking" block. <details>/<summary>/<pre> are all in
 * VS Code's HTML allowlist, so with supportHtml this renders as a native
 * collapsed section in chat: user clicks to expand ("- Thinking" state).
 * Stable API only — no proposed API needed, works for every user.
 */
function thinkingDetailsMarkdown(
    thinking: string
): vscode.MarkdownString {
    const MAX_DETAILS = 8000;
    const text = thinking.trim();
    const shown = text.length > MAX_DETAILS
        ? text.slice(0, MAX_DETAILS).trim() +
          '\n…(truncated — full trace in Output log, or "View Qwen thinking")'
        : text;
    const escaped = shown
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    const md = new vscode.MarkdownString(
        `<details>\n<summary>+ Thinking (${text.length} chars — click to expand)</summary>\n\n` +
        `<pre>${escaped}</pre>\n\n</details>`
    );
    md.supportHtml = true;
    return md;
}

/** Collapsed thinking UX: details block + backup button (opens in editor). */
function showThinkingCollapsed(
    stream: vscode.ChatResponseStream,
    thinking: string
): void {
    if (!thinking.trim()) {
        return;
    }
    stream.markdown(thinkingDetailsMarkdown(thinking));
    stream.button({
        command: 'ai-copilot-bridge.showLastThinking',
        title: 'View Qwen thinking'
    });
}

/** Tail of partial output included when resuming (keeps resume prompts small). */
const RESUME_TAIL_CHARS = 2000;

/**
 * Continuation prompt for Wait-resume: the model continues reasoning AND
 * answering from its own partial output instead of restarting from scratch.
 */
function buildResumeNote(
    partialThinking: string,
    partialContent: string
): string {
    const thinkTail = partialThinking.trim().slice(-1500);
    const contentTail = partialContent.trim().slice(-RESUME_TAIL_CHARS);
    let note =
        '[CONTINUATION — your previous attempt was cut off by timeout. ' +
        'Do NOT restart from scratch: keep thinking briefly from where your ' +
        'reasoning stopped, then answer. Do NOT repeat text already produced.';
    if (thinkTail) {
        note +=
            `\nYour reasoning so far (continue it, do not redo it):\n---\n${thinkTail}\n---`;
    }
    if (contentTail) {
        note +=
            `\nYour partial answer so far (continue from here):\n---\n${contentTail}\n---`;
    }
    if (!thinkTail && !contentTail) {
        note +=
            ' Nothing was produced yet — proceed directly with minimal reasoning.';
    }
    return note + ']';
}

/** Live thinking quote printer (throttled). Shared pattern for agentic steps. */
function createThinkingLivePrinter(
    stream: vscode.ChatResponseStream,
    cap = 4000
): { push(thinking: string, force: boolean): void } {
    let linesFlushed = 0;
    let charsFlushed = 0;
    let capped = false;
    let lastFlush = 0;
    return {
        push(thinking: string, force: boolean): void {
            const now = Date.now();
            if (!force && now - lastFlush < 400) {
                return;
            }
            lastFlush = now;
            const lines = thinking.split('\n');
            const complete = force ? lines.length : lines.length - 1;
            for (let i = linesFlushed; i < complete; i++) {
                if (charsFlushed >= cap) {
                    if (!capped) {
                        capped = true;
                        stream.markdown(
                            `> …(live thinking truncated, full trace at the end)\n`
                        );
                    }
                    break;
                }
                if (lines[i].trim() === '') {
                    continue;
                }
                charsFlushed += lines[i].length + 1;
                stream.markdown(`> ${lines[i]}\n`);
            }
            linesFlushed = complete;
        }
    };
}

/** Final Qwen display shared by agentic mode (no live stream there). */
function showQwenFinal(
    stream: vscode.ChatResponseStream,
    thinking: string,
    content: string
): void {
    const showThinking = getConfig<boolean>('ollama.showThinking', true);
    const collapsed = getConfig<boolean>('ollama.thinkingCollapsed', true);

    if (showThinking && thinking.trim() && !collapsed) {
        const MAX_INLINE = 4000;
        const shown = thinking.length > MAX_INLINE
            ? thinking.slice(0, MAX_INLINE).trim() +
              `\n\n…(thinking truncated, full trace in Output log)`
            : thinking;
        stream.markdown(
            `**Thinking:**\n\n` +
            shown.split('\n').map(l => `> ${l}`).join('\n') +
            `\n\n`
        );
    }

    stream.markdown(`${content.trim() || '(no final answer, thinking only)'}\n\n`);

    if (showThinking && collapsed && thinking.trim()) {
        showThinkingCollapsed(stream, thinking);
    }
}

async function resolveModel(
    request: vscode.ChatRequest
): Promise<vscode.LanguageModelChat> {

    // Follow the GitHub Copilot model list. If the user picked a concrete
    // model (GPT, Claude, ...) use it. If they picked "Auto" (a router,
    // not a real LLM) or nothing, resolve to a concrete Copilot model.
    const available =
        await vscode.lm.selectChatModels(
            { vendor: 'copilot' }
        );

    console.log(
        '[AI Copilot Bridge] Copilot models: ' +
        (available.map(m => `${m.vendor}/${m.family} (${m.name}) [${m.id}]`).join(' | ') || '(none)')
    );

    if (request.model && !isAutoPseudoModel(request.model)) {
        console.log(
            `[AI Copilot Bridge] Lead model: ${request.model.vendor}/${request.model.family} (${request.model.name})`
        );
        return request.model;
    }

    if (request.model) {
        console.log(
            `[AI Copilot Bridge] Picker is Auto (${request.model.name}), resolving to concrete model...`
        );
    }

    const fallback = pickConcreteModel(available);

    if (!fallback) {
        throw new Error(
            'No concrete Copilot language model available (only "Auto" found). ' +
            'Please pick a specific model like GPT-4o in the Chat model picker, ' +
            'and sign in to GitHub Copilot.'
        );
    }

    console.log(
        `[AI Copilot Bridge] Lead model (resolved from Auto): ${fallback.vendor}/${fallback.family} (${fallback.name})`
    );

    return fallback;
}

export async function runAgent(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<void> {

    const maxRounds =
        getConfig<number>(
            'maxRounds',
            5
        );

    const toolsEnabled = getConfig<boolean>(
        'enableTools',
        true
    );

    let activeTools: vscode.LanguageModelChatTool[] =
        toolsEnabled
            ? selectTools(request.prompt)
            : [];

    if (!toolsEnabled) {
        console.log(
            '[AI Copilot Bridge] Native tools disabled by setting.'
        );
    }

    const history =
        context.history
            .slice(-10)
            .map(item => {

                if (
                    item instanceof
                    vscode.ChatRequestTurn
                ) {
                    return `USER: ${item.prompt}`;
                }

                if (
                    item instanceof
                    vscode.ChatResponseTurn
                ) {

                    let text = '';

                    for (
                        const part of item.response
                    ) {

                        if (
                            part instanceof
                            vscode.ChatResponseMarkdownPart
                        ) {
                            text += part.value.value;
                        }
                    }

                    return text
                        ? `LEAD: ${text}`
                        : '';
                }

                return '';
            })
            .filter(Boolean)
            .join('\n\n');

    const fileTask = wantsFileOps(request.prompt);

    // FREE grounding (no lead tokens spent): the workspace snapshot travels
    // with the request so the lead can write fully-specified orders on turn 1
    // instead of burning tool rounds discovering the obvious.
    let workspaceSnapshot = '';
    try {
        const ws0 = await getWorkspaceContext();
        if (ws0.workspacePath) {
            workspaceSnapshot = formatWorkspaceContext(ws0, 60);
        }
    } catch {
        workspaceSnapshot = '';
    }

    const messages:
        vscode.LanguageModelChatMessage[] =
        [
            vscode.LanguageModelChatMessage.User(
                `
${SYSTEM_PROMPT}

CONVERSATION HISTORY:

${history || '(none)'}

CURRENT USER REQUEST:

${request.prompt}
${workspaceSnapshot ? `
${workspaceSnapshot}

(Use this snapshot for paths — do not re-list what is already listed above.)
` : ''}
${fileTask ? `
FILE TASK — LEAD-LIGHT WORKFLOW (minimize your own tool calls):
- Qwen (local worker WITH tools: local_write_file etc.) executes file work.
  User-explicit new-file writes skip your approval entirely by design.
- Your job: EITHER do it directly in 1-2 tool calls, OR delegate ONCE with a
  fully-specified task (exact relative paths + exact content + verification).
- Do NOT narrate ("I will create...") — emit a tool call, a delegation JSON,
  or the final answer. A text-only turn that advances nothing is a FAILURE.
` : ''}
`
            )
        ];

    let qwenFailed = false;
    let toolsUsed = false;
    // Set once the user skips Qwen: from then on the lead must NEVER
    // delegate again — it finishes the task itself with native tools.
    let qwenSkipped = false;
    let qwenSkipNoted = false;
    // Copilot tool calls Qwen itself executed across all rounds (agentic
    // mode). >0 means work may already be on disk — lead verifies.
    let qwenToolsRan = 0;
    // Times we refused a cop-out ending (apology/narration with no tool
    // call) on a file task and forced the lead to act. Bounded so a
    // stubborn model cannot loop forever.
    let toolNudges = 0;
    const MAX_TOOL_NUDGES = 2;

    let model = await resolveModel(request);
    let lead = leadLabel(model);
    let modelSwitched = false;

    // Show which lead model is actually in use (picker may say "Auto"
    // but we resolve it to a concrete Copilot model — see resolveModel).
    {
        const picked = request.model
            ? `${request.model.vendor}/${request.model.family} (${request.model.name})`
            : '(none)';
        stream.markdown(
            `> Lead model: **${lead}** · picker: ${picked} · tools: ` +
            `${activeTools.length} · local: ${getConfig<string>('ollama.model', 'qwen3:4b')}\n\n` +
            `> Tip: \`@multi /models\` lists all Copilot models available to this extension.\n\n`
        );
    }

    // Special command: list Copilot models visible to the extension.
    if (/^\s*\/(models|model)\s*$/i.test(request.prompt)) {
        const available =
            await vscode.lm.selectChatModels({ vendor: 'copilot' });
        if (available.length === 0) {
            stream.markdown(
                'No Copilot models found. Sign in to GitHub Copilot first.\n'
            );
        } else {
            const lines = available.map(m =>
                `- ${m.vendor}/${m.family} **(${m.name})** \`[${m.id}]\`` +
                (isAutoPseudoModel(m) ? ' — router, cannot be called directly' : '') +
                (m.id === model.id ? ' ← in use' : '')
            );
            stream.markdown(
                `### Copilot models visible to AI Copilot Bridge\n\n${lines.join('\n')}\n`
            );
        }
        return;
    }

    stream.progress(
        `${lead} is thinking...`
    );

    for (
        let round = 1;
        round <= maxRounds;
        round++
    ) {

        if (
            token.isCancellationRequested
        ) {
            return;
        }

        let turn: AgentTurnResult;

        try {

            turn = await askGPT(
                model,
                messages,
                activeTools,
                token
            );

        } catch (error) {

            if (
                token.isCancellationRequested
            ) {
                return;
            }

            console.error(
                '[AI Copilot Bridge] Lead model failed:',
                error
            );

            const autoError = isAutoModeError(error);
            const retryable = autoError || isRetryableModelError(error);

            if (retryable && !modelSwitched) {
                // The "Auto" router model (and sometimes a stale model
                // handle) always throws Auto errors — even with zero tools.
                // Transient Copilot routing errors ("No lowest priority
                // node found", rate limits, overloads) are also worth one
                // retry on a different concrete model.
                try {
                    const available =
                        await vscode.lm.selectChatModels(
                            { vendor: 'copilot' }
                        );
                    const next = pickConcreteModel(
                        available,
                        model.id
                    ) ?? pickConcreteModel(available);

                    if (next && next.id !== model.id) {
                        const reason = autoError
                            ? '"Auto mode needs a prompt"'
                            : 'a transient Copilot routing error';
                        model = next;
                        lead = leadLabel(model);
                        modelSwitched = true;
                        stream.markdown(
                            `The selected Chat model could not handle the request ` +
                            `(${reason}: ${error instanceof Error ? error.message : String(error)}). ` +
                            `Switched to **${lead}** and retrying...\n\n` +
                            `Tip: pick a concrete model (e.g. GPT-4o) in the Chat model picker instead of "Auto".\n\n`
                        );
                        round--;
                        continue;
                    }
                } catch (switchError) {
                    console.error(
                        '[AI Copilot Bridge] Model switch failed:',
                        switchError
                    );
                }
            }

            if (retryable) {
                // askGPT already retried without tools once; if we are
                // here it still failed. Disable tools for the rest of
                // the session and try once more without tools.
                if (activeTools.length > 0) {
                    activeTools = [];
                    stream.markdown(
                        `The request hit a routing error (` +
                        `${error instanceof Error ? error.message : String(error)}), ` +
                        `so continuing without tools for this request.\n\n`
                    );
                    round--;
                    continue;
                }
            }

            stream.markdown(
                `**${lead} error:** ${error instanceof Error ? error.message : String(error)}\n\n` +
                `This looks like a transient Copilot server issue — just try again. ` +
                `If it persists, pick a concrete Chat model (e.g. GPT-4o / Claude, not "Auto"), ` +
                `or set \`aiCopilotBridge.enableTools\` to false if tools keep failing.\n`
            );
            return;
        }

        if (
            turn.toolCalls.length > 0
        ) {

            toolsUsed = true;

            const assistantContent:
                vscode.LanguageModelToolCallPart[] =
                turn.toolCalls;

            messages.push(
                vscode.LanguageModelChatMessage.Assistant(
                    assistantContent
                )
            );

            // Make the Lead's own work VISIBLE (not just a transient
            // progress line): list every Copilot tool call it makes.
            stream.markdown(
                `> ${lead} calls ` +
                turn.toolCalls
                    .map(c => `\`${describeLeadCall(c.name, c.input)}\``)
                    .join(', ') +
                `\n\n`
            );

            const { results: toolResults, ok: toolOk } =
                await executeTools(
                    turn.toolCalls,
                    request,
                    token
                );

            messages.push(
                vscode.LanguageModelChatMessage.User(
                    toolResults
                )
            );

            stream.markdown(
                turn.toolCalls
                    .map((c, i) =>
                        `> ${lead}: ${c.name} — ${toolOk[i] === false ? 'failed' : 'done'}\n`
                    )
                    .join('') + `\n`
            );

            stream.progress(
                `${lead} is using VS Code tools...`
            );

            continue;
        }

        // Text-written calls: the lead sometimes renders a function call as
        // JSON text instead of emitting a real tool call — run it anyway
        // (same runners, same chat visibility) instead of stalling.
        {
            const known = new Set<string>([
                ...activeTools.map(t => t.name),
                ...getLocalToolDefs().map(t => t.function.name)
            ]);
            const textCalls = extractTextToolCalls(turn.text, known);

            if (textCalls.length > 0) {
                toolsUsed = true;

                const root =
                    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

                stream.markdown(
                    `> ${lead} wrote ${textCalls.length} call(s) as text — running anyway:\n` +
                    textCalls
                        .map(c => `> \`${describeLeadCall(c.name, c.input)}\`\n`)
                        .join('') +
                    `\n`
                );

                const callParts: vscode.LanguageModelToolCallPart[] = [];
                const resultParts: vscode.LanguageModelToolResultPart[] = [];

                for (let i = 0; i < textCalls.length; i++) {
                    const call = textCalls[i];
                    const callId = `lead-text-${Date.now()}-${i}`;
                    callParts.push(
                        new vscode.LanguageModelToolCallPart(
                            callId,
                            call.name,
                            call.input
                        )
                    );

                    try {
                        if (call.name.startsWith('local_')) {
                            const out = await runLocalTool(
                                { name: call.name, args: call.input },
                                root
                            );
                            resultParts.push(
                                new vscode.LanguageModelToolResultPart(
                                    callId,
                                    [new vscode.LanguageModelTextPart(out)]
                                )
                            );
                            stream.markdown(`> ${lead}: ${call.name} — done (from text)\n\n`);
                        } else {
                            const res = await vscode.lm.invokeTool(
                                call.name,
                                {
                                    input: call.input,
                                    toolInvocationToken:
                                        request.toolInvocationToken
                                },
                                token
                            );
                            resultParts.push(
                                new vscode.LanguageModelToolResultPart(
                                    callId,
                                    res.content
                                )
                            );
                            stream.markdown(`> ${lead}: ${call.name} — done (from text)\n\n`);
                        }
                    } catch (error) {
                        const message =
                            error instanceof Error ? error.message : String(error);
                        resultParts.push(
                            new vscode.LanguageModelToolResultPart(
                                callId,
                                [new vscode.LanguageModelTextPart(
                                    `Tool "${call.name}" failed: ${message}`
                                )]
                            )
                        );
                        stream.markdown(`> ${lead}: ${call.name} — failed: ${message}\n\n`);
                    }

                    if (token.isCancellationRequested) {
                        return;
                    }
                }

                messages.push(
                    vscode.LanguageModelChatMessage.Assistant(callParts)
                );
                messages.push(
                    vscode.LanguageModelChatMessage.User(resultParts)
                );

                continue;
            }
        }

        const decision =
            extractDecision(turn.text);

        if (!decision) {

            // Plain Markdown from lead = final answer. No JSON needed —
            // UNLESS a file task is still undone (no tool ran yet). Then a
            // text-only turn is a cop-out (often an apology or narration
            // like "I will now inspect..."): refuse it and force a tool call.
            if (fileTask && !toolsUsed && qwenToolsRan === 0 && toolNudges < MAX_TOOL_NUDGES) {
                toolNudges++;
                messages.push(
                    vscode.LanguageModelChatMessage.Assistant(turn.text)
                );
                messages.push(
                    vscode.LanguageModelChatMessage.User(
                        `STOP. The file task is NOT done — no native tool has run yet, so nothing exists on disk. Your "I will..." narration does nothing. Your NEXT response MUST be a native tool call (inspect the workspace first if you have not). Do NOT write any text — emit the tool call.`
                    )
                );
                stream.progress(
                    `${lead} is working on the file...`
                );
                continue;
            }

            stream.markdown(
                turn.text
            );

            return;
        }

        if (
            decision.action === 'final'
        ) {

            // Same guard for JSON "final": never accept a file-task finish
            // with zero tool calls (up to MAX_TOOL_NUDGES times).
            if (fileTask && !toolsUsed && qwenToolsRan === 0 && toolNudges < MAX_TOOL_NUDGES) {
                toolNudges++;
                messages.push(
                    vscode.LanguageModelChatMessage.Assistant(turn.text)
                );
                messages.push(
                    vscode.LanguageModelChatMessage.User(
                        `STOP. You returned "final" but no native tool has run yet — the file does NOT exist. Your NEXT response MUST be a native tool call that moves the file task forward (inspect workspace, write, verify). Do NOT return "final" again until a tool has run.`
                    )
                );
                stream.progress(
                    `${lead} is working on the file...`
                );
                continue;
            }

            stream.markdown(
                decision.message
            );

            return;
        }

        // User skipped Qwen earlier in THIS request: never delegate again.
        // Without this, the lead bounces the task back to Qwen (which just
        // failed), the user watches another timeout, and nothing finishes.
        if (qwenSkipped) {
            messages.push(
                vscode.LanguageModelChatMessage.Assistant(turn.text)
            );
            messages.push(
                vscode.LanguageModelChatMessage.User(
                    `Qwen was SKIPPED by the user earlier in this request and stays skipped. ` +
                    `Do NOT return ask/delegate/discuss — there will be no Qwen round. ` +
                    `Finish the task YOURSELF with native VS Code tools now ` +
                    `(inspect workspace, write, verify), or if nothing actionable remains, ` +
                    `return {"action":"final","message":"..."} with the real outcome. ` +
                    `Narration without tool calls is a FAILURE.`
                )
            );
            if (!qwenSkipNoted) {
                qwenSkipNoted = true;
                stream.markdown(
                    `> Qwen was skipped — Lead continues alone with native tools.\n\n`
                );
            }
            stream.progress(`${lead} is working...`);
            continue;
        }

        stream.markdown(
            `### ${lead} — orders to Qwen (${decision.action})\n\n` +
            `**Lead understood:** ${request.prompt.slice(0, 300)}${request.prompt.length > 300 ? '…' : ''}\n\n` +
            `**Orders:**\n\n${decision.message}\n\n`
        );

        stream.progress(
            `Qwen is working...`
        );

        // Agentic Qwen (Copilot tools + lead-gated approval) for real work:
        // file tasks, or anything beyond a plain opinion (delegate/discuss).
        // Plain "ask" stays in fast text-only mode.
        const useQwenAgent =
            getConfig<boolean>('qwenToolsEnabled', true) &&
            (fileTask || decision.action !== 'ask');

        const localPrompt = `
The lead AI (${lead}) has assigned you a text-only task.

You have NO tools and NO workspace access.
Do NOT try to create files or run commands.
Just return the requested TEXT content.

USER REQUEST:

${request.prompt}

LEAD TASK:

${decision.message}

Provide useful text: conclusions, recommendations,
code snippets, or review results.

Do not claim final authority.
Do not provide chain-of-thought.
`;

        let qwenResult: OllamaResult | null = null;
        let qwenError = '';

        // Ask Qwen, but on failure ASK THE USER (weak-PC friendly):
        // WAIT = keep waiting (retry with a longer timeout),
        // SKIP = skip Qwen and continue with the Lead AI.
        // Each wait extends the timeout so slow PCs eventually finish.
        let waitCount = 0;
        let qwenTimeout = getConfig<number>('ollama.timeout', 180000);
        // First network call also loads the model (zero tokens for minutes
        // on slow PCs) — one-time idle bonus so load time never kills it.
        const FIRST_LOAD_BONUS_MS = 120000;
        // Resume state: after a timeout, Wait continues Qwen's reasoning
        // AND answer from its partial output instead of starting over.
        let resumeThinking = '';
        let resumeContent = '';
        let thinkingAllSimple = '';
        const WAIT_STEP_MS = 120000;
        const MAX_TIMEOUT_MS = 1800000;

        const showThinking = getConfig<boolean>(
            'ollama.showThinking',
            true
        );
        // Collapsed = one "+ Thinking" line + a button to view the full
        // trace. Inline = live quote dump (previous behavior).
        const thinkingCollapsed = getConfig<boolean>(
            'ollama.thinkingCollapsed',
            true
        );
        const thinkingInline = showThinking && !thinkingCollapsed;
        let qwenHeaderShown = false;

        if (useQwenAgent) {

            // Never die silently here: any unexpected throw becomes a visible
            // Qwen failure so the lead continues alone (skip path below).
            try {

                stream.progress(`Contacting local AI (${getOllamaConfig().model})...`);

                const agent = await runQwenAgent({
                    task: decision.message,
                    userRequest: request.prompt,
                    lead,
                    model,
                    request,
                    stream,
                    token,
                    fileTask
                });

                if (
                    token.isCancellationRequested ||
                    (!agent.ok && agent.error === 'cancelled')
                ) {
                    return;
                }

                if (agent.ok) {
                    qwenResult = agent.value;
                    qwenToolsRan += agent.toolsRan;
                } else if (!/tool/i.test(agent.error)) {
                    // Real failure (offline/timeout/skip): lead continues alone.
                    qwenError = agent.error;
                } else {
                    // Model cannot do tool-calling: fall through to text mode.
                    stream.markdown(
                        `Qwen agentic mode unavailable (${agent.error}); ` +
                        `falling back to text mode.\n\n`
                    );
                }

            } catch (error) {

                if (token.isCancellationRequested) {
                    return;
                }

                const message =
                    error instanceof Error ? error.message : String(error);

                console.error(
                    '[AI Copilot Bridge] Qwen branch crashed (recovered):',
                    error
                );

                qwenError =
                    `Local AI crashed unexpectedly and was skipped: ${message}`;
            }
        }

        // Text-only path: fresh Qwen call, or fallback when the local model
        // cannot handle tool calls. Skipped when agentic already delivered
        // (qwenResult set) or failed hard (qwenError set).
        if (qwenResult === null && qwenError === '') {
        for (;;) {

            try {

                if (!qwenHeaderShown) {
                    qwenHeaderShown = true;
                    stream.markdown(
                        `### Qwen (${getOllamaConfig().model}) — Local AI\n\n` +
                        `> Orders received — starting.\n\n`
                    );
                    if (thinkingInline) {
                        stream.markdown(`**Thinking (live):**\n\n`);
                    } else if (showThinking) {
                        stream.progress(`Qwen is thinking...`);
                    }
                } else if (resumeThinking || resumeContent) {
                    stream.markdown(`\n*(continuing from where Qwen stopped — thinking continues, no restart)*\n\n`);
                } else {
                    stream.markdown(`\n*(retrying Qwen...)*\n\n`);
                }

                // Live token streaming: thinking streams as quote lines,
                // answer content streams raw — token-by-token as Ollama
                // generates them. Flush throttled so chat isn't spammed.

                // Max thinking chars shown live; full trace goes to Output log.
                const MAX_LIVE_THINKING = 4000;
                let thinkingLinesFlushed = 0;
                let thinkingCharsFlushed = 0;
                let thinkingClosed = false;
                let thinkingCapped = false;
                let contentFlushed = 0;
                let lastFlush = 0;

                const flushLive = (
                    thinking: string,
                    content: string,
                    force: boolean
                ): void => {
                    const now = Date.now();
                    if (!force && now - lastFlush < 400) {
                        return;
                    }
                    lastFlush = now;

                    if (thinkingInline && !thinkingClosed) {
                        const lines = thinking.split('\n');
                        // Flush only complete lines; the last line may still
                        // be growing — unless content already started or this
                        // is the final flush.
                        const complete =
                            content.length > 0 || force
                                ? lines.length
                                : lines.length - 1;
                        for (
                            let i = thinkingLinesFlushed;
                            i < complete;
                            i++
                        ) {
                            if (thinkingCharsFlushed >= MAX_LIVE_THINKING) {
                                if (!thinkingCapped) {
                                    thinkingCapped = true;
                                    stream.markdown(
                                        `> …(thinking truncated, full trace in Output log)\n`
                                    );
                                }
                                break;
                            }
                            if (lines[i].trim() === '') {
                                continue;
                            }
                            thinkingCharsFlushed += lines[i].length + 1;
                            stream.markdown(`> ${lines[i]}\n`);
                        }
                        thinkingLinesFlushed = complete;
                        if (content.length > 0) {
                            thinkingClosed = true;
                            stream.markdown(`\n`);
                        }
                    }

                    if (content.length > contentFlushed) {
                        stream.markdown(
                            content.slice(contentFlushed)
                        );
                        contentFlushed = content.length;
                    }
                };

                qwenResult =
                    await askOllama(
                        (resumeThinking || resumeContent)
                            ? localPrompt + '\n\n' + buildResumeNote(
                                resumeThinking,
                                resumeContent
                            )
                            : localPrompt,
                        token,
                        qwenTimeout + (waitCount === 0 ? FIRST_LOAD_BONUS_MS : 0),
                        (thinking, content) =>
                            flushLive(thinking, content, false)
                    );

                flushLive(
                    qwenResult.thinking,
                    qwenResult.content,
                    true
                );

                console.log(
                    `[AI Copilot Bridge] Qwen thinking (${qwenResult.thinking.length} chars):\n${qwenResult.thinking}`
                );

                // Accumulate thinking across resume attempts: the final
                // attempt runs with think=false, so without this the
                // details block would be empty.
                thinkingAllSimple += qwenResult.thinking;

                lastThinking = {
                    text: thinkingAllSimple,
                    model: getOllamaConfig().model,
                    at: Date.now()
                };

                // Collapsed mode hid thinking during streaming: show the
                // "+ Thinking" details block now (answer already streamed).
                if (showThinking && thinkingCollapsed) {
                    showThinkingCollapsed(stream, thinkingAllSimple);
                }

                stream.markdown(`\n\n`);

                break;

            } catch (error) {

                if (
                    token.isCancellationRequested
                ) {
                    return;
                }

                qwenError =
                    error instanceof Error
                        ? error.message
                        : String(error);

                console.error(
                    '[AI Copilot Bridge] Qwen failed:',
                    error
                );

                // Keep partial output for resume: Wait continues reasoning
                // and answering from here instead of starting over.
                if (error instanceof QwenPartialError) {
                    if (error.partialThinking.trim()) {
                        thinkingAllSimple += error.partialThinking.trim() + '\n';
                        resumeThinking = error.partialThinking;
                    }
                    resumeContent = error.partialContent;
                }

                const nextTimeout = Math.min(
                    qwenTimeout + WAIT_STEP_MS,
                    MAX_TIMEOUT_MS
                );

                const choice = await askUserOnQwenFailure(
                    qwenError,
                    waitCount,
                    Math.round(nextTimeout / 1000),
                    stream,
                    token
                );

                if (choice === 'wait') {
                    waitCount++;
                    qwenTimeout = nextTimeout;
                    stream.progress(`Qwen is working (wait x${waitCount}, timeout ${Math.round(qwenTimeout / 1000)}s)...`);
                    continue;
                }

                break;
            }
        }
        } // end text-only path guard

        if (qwenResult === null) {

            qwenFailed = true;
            qwenSkipped = true;

            messages.push(
                vscode.LanguageModelChatMessage.Assistant(
                    turn.text
                )
            );

            messages.push(
                vscode.LanguageModelChatMessage.User(
                    `
QWEN FAILED WITH ERROR (user chose to skip):

${qwenError}

Qwen is unavailable. YOU must finish the task alone as the lead AI
using your own knowledge and native VS Code tools.

STRICT RULES FOR THIS TURN AND THE NEXT TURNS:
- Do NOT end the task with an apology, excuse, or summary of what you
  "will do" ("I will now inspect...", "I cannot because Qwen...").
- If the user asked for a file: your NEXT response MUST be a native
  tool call that moves the file task forward (inspect workspace, then
  write, then verify). Text without a tool call is a FAILURE.
- If no file was asked for: answer the user directly in Markdown with
  real substance, or return {"action":"final","message":"..."}.
`
                )
            );

            continue;
        }

        if (!qwenResult.content.trim() && !qwenResult.thinking.trim()) {
            stream.markdown(`(Qwen returned an empty response.)\n\n`);
            qwenResult = {
                content: '(Qwen returned an empty response.)',
                thinking: ''
            };
        }

        messages.push(
            vscode.LanguageModelChatMessage.Assistant(
                turn.text
            )
        );

        // GOAL 2 — VERIFY THEN REDO: after Qwen acted with tools on a file
        // task, the BRIDGE checks disk directly (free) and tells the lead
        // the verdict. Pass = confirm immediately. Fail = redo, never report
        // success on missing files.
        let verifyNote = '';

        if (fileTask && qwenToolsRan > 0) {
            const wsRoot =
                vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            try {
                const v = await verifyFilesOnDisk(request.prompt, wsRoot);
                if (!v.skipped && v.checked.length > 0 && v.missing.length === 0) {
                    verifyNote =
                        `MECHANICAL VERIFICATION PASSED (bridge checked disk directly, zero lead tokens spent): ` +
                        `these files EXIST: ${v.checked.join(', ')}. ` +
                        `Confirm completion to the user now — final answer, no more tools needed unless you spot a real problem.`;
                    stream.markdown(
                        `> Bridge verified on disk: ${v.checked.join(', ')} — Lead confirming.\n\n`
                    );
                } else if (!v.skipped && v.missing.length > 0) {
                    verifyNote =
                        `MECHANICAL VERIFICATION FAILED (bridge checked disk directly): ` +
                        `MISSING: ${v.missing.join(', ')}` +
                        (v.checked.length ? ` (found: ${v.checked.join(', ')})` : ``) +
                        `. Qwen reported done but the file is NOT on disk. ` +
                        `REDO NOW: fix it yourself with native tools, or re-delegate to Qwen ONCE ` +
                        `with corrected exact instructions (verify path + content). Do NOT report success.`;
                    stream.markdown(
                        `> Bridge: ${v.missing.join(', ')} NOT on disk — Lead redoing.\n\n`
                    );
                }
            } catch {
                // Verification itself failed: fall through to normal review.
            }
        }

        messages.push(
            vscode.LanguageModelChatMessage.User(
                `
${qwenToolsRan > 0
? `QWEN ACTED VIA TOOLS (${qwenToolsRan} Copilot tool calls, approved per policy).
Qwen's summary:
`
: `QWEN LOCAL AI RESPONSE (draft TEXT content — nothing has been written to disk):

`}
${qwenResult.content}

${qwenResult.thinking.trim() ? `(Qwen's internal thinking was hidden from this context to save tokens.)` : ``}

Continue as the lead AI.
${verifyNote ? verifyNote : (fileTask && !toolsUsed && qwenToolsRan === 0 ? `
MANDATORY NEXT STEP: the user asked for a file and NO tool has run yet.
Qwen's text above is only a draft. YOU must now emit a REAL native tool call:
1. Inspect the workspace to find the project root (one tool call now).
2. On the following turn, write the file with the draft content (adapted).
Do NOT reply with narration like "CALL to create..." or "I will create...".
Do NOT ask the user for content — you already have Qwen's draft.
Emit the tool call NOW.
` : `
You may:
- verify Qwen's work with your own VS Code tools (recommended for file tasks)
- use VS Code tools for remaining work
- ask Qwen again
- finish with a direct Markdown answer
  (preferred), or return {"action":"final","message":"..."}.
`)}
`
            )
        );
    }

    if (qwenFailed) {
        stream.progress(
            `Qwen was skipped, ${lead} is finalizing...`
        );
    } else {
        stream.progress(
            'Preparing the final answer...'
        );
    }

    const finalMessages = [
        ...messages,

        vscode.LanguageModelChatMessage.User(
            `
The maximum collaboration rounds have been reached.

Provide the best final answer to the user now
in normal Markdown (no JSON wrapper needed).
If a file was requested, make sure you created it with tools.
`
        )
    ];

    let finalTurn: AgentTurnResult;

    try {

        finalTurn =
            await askGPT(
                model,
                finalMessages,
                activeTools,
                token
            );

    } catch (error) {

        if (token.isCancellationRequested) {
            return;
        }

        stream.markdown(
            `**${lead} error on final answer:** ${error instanceof Error ? error.message : String(error)}\n\n` +
            `This looks transient — please try again.\n`
        );
        return;
    }

    const finalDecision =
        extractDecision(
            finalTurn.text
        );

    if (
        finalDecision &&
        finalDecision.action === 'final'
    ) {

        stream.markdown(
            finalDecision.message
        );

        return;
    }

    stream.markdown(
        finalTurn.text
    );
}