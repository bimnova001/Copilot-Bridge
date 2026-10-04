import * as vscode from 'vscode';

/** A tool call requested by the local model (Ollama tool-calling format). */
export interface LocalToolCall {
    name: string;
    args: any;
}

/** An Ollama function-tool definition built from a VS Code/Copilot tool. */
export interface LocalToolDef {
    type: 'function';
    function: { name: string; description: string; parameters: any };
}

interface OllamaStreamChunk {
    message?: {
        content?: string;
        thinking?: string;
    };
    done?: boolean;
    error?: string;
}

export interface OllamaResult {
    /** Final answer text (thinking tags stripped). */
    content: string;
    /** Qwen's thinking/reasoning trace (may be empty for non-thinking models). */
    thinking: string;
}

/** Called with cumulative buffers as tokens stream in. */
export type OllamaTokenCallback = (
    thinking: string,
    content: string
) => void;

function getSetting<T>(key: string, defaultValue: T): T {
    return vscode.workspace
        .getConfiguration('aiCopilotBridge')
        .get<T>(key, defaultValue);
}

export function getOllamaConfig(): {
    url: string;
    model: string;
    timeout: number;
} {
    return {
        url: getSetting(
            'ollama.url',
            'http://localhost:11434'
        ).replace(/\/$/, ''),
        model: getSetting(
            'ollama.model',
            'qwen3:4b'
        ),
        timeout: getSetting(
            'ollama.timeout',
            180000
        )
    };
}

/** Error carrying whatever Qwen had already generated when it was cut off. */
export class QwenPartialError extends Error {
    partialThinking: string;
    partialContent: string;
    constructor(message: string, thinking: string, content: string) {
        super(message);
        this.name = 'QwenPartialError';
        this.partialThinking = thinking;
        this.partialContent = content;
    }
}

/**
 * Idle-based abort timers: the clock RESETS on every output chunk, so slow
 * thinking never trips the timeout — only genuine stalls (silence) do.
 * An absolute cap still bounds the total run.
 */
interface AbortTimers {
    refresh: () => void;
    dispose: () => void;
    isTimedOut: () => boolean;
    wasIdle: () => boolean;
}

function createAbortTimers(
    controller: AbortController,
    idleMs: number,
    absoluteMs: number
): AbortTimers {
    let timedOut = false;
    let idleFired = false;
    let idleHandle: ReturnType<typeof setTimeout> | undefined;

    const fire = (idle: boolean): void => {
        if (!timedOut) {
            timedOut = true;
            idleFired = idle;
            try {
                controller.abort();
            } catch {
                // Already aborted — nothing to do.
            }
        }
    };

    const armIdle = (): void => {
        if (idleHandle) {
            clearTimeout(idleHandle);
        }
        idleHandle = setTimeout(() => fire(true), idleMs);
    };

    armIdle();
    const absoluteHandle = setTimeout(() => fire(false), absoluteMs);

    return {
        refresh: () => {
            if (!timedOut) {
                armIdle();
            }
        },
        dispose: () => {
            if (idleHandle) {
                clearTimeout(idleHandle);
            }
            clearTimeout(absoluteHandle);
        },
        isTimedOut: () => timedOut,
        wasIdle: () => idleFired
    };
}

function timeoutMessage(
    idle: boolean,
    idleSecs: number,
    absoluteSecs: number,
    url: string,
    model: string
): string {
    return idle
        ? `Qwen stalled: no output for ${idleSecs}s (timeout counts silence only, not thinking time). ` +
          `The PC may be overloaded or Ollama stuck. Check Ollama at ${url} and model "${model}".`
        : `Qwen exceeded the absolute limit of ${absoluteSecs}s. ` +
          `Check Ollama at ${url} and model "${model}".`;
}

export async function askOllama(
    prompt: string,
    token: vscode.CancellationToken,
    timeoutOverrideMs?: number,
    onToken?: OllamaTokenCallback,
    think = true
): Promise<OllamaResult> {

    const url = getSetting(
        'ollama.url',
        'http://localhost:11434'
    ).replace(/\/$/, '');

    const model = getSetting(
        'ollama.model',
        'qwen3:4b'
    );

    const timeout = timeoutOverrideMs ?? getSetting(
        'ollama.timeout',
        180000
    );

    const controller =
        new AbortController();

    // Idle timeout = silence limit (resets on every token); absolute caps
    // the total run. Thinking time itself never counts.
    const timers = createAbortTimers(controller, timeout, timeout * 4);

    const cancellationDisposable =
        token.onCancellationRequested(() => {
            controller.abort();
        });

    // Buffers live outside try so a timeout can carry partial output
    // (resume continues from these instead of starting over).
    let thinking = '';
    let content = '';

    try {

        const response = await fetch(
            `${url}/api/chat`,
            {
                method: 'POST',

                headers: {
                    'Content-Type':
                        'application/json'
                },

                body: JSON.stringify({
                    model,

                    messages: [
                        {
                            role: 'system',

                            content: `
You are the local AI worker.

The lead AI (GPT, Claude, or another Copilot model) is the final decision maker.

Your role is to:
- analyze
- review
- debug
- research
- suggest alternatives
- identify risks
- provide code when useful

Do not claim final authority.

Do not provide chain-of-thought.

Return useful conclusions, evidence,
recommendations, or code.
`
                        },

                        {
                            role: 'user',
                            content: prompt
                        }
                    ],

                    // Stream tokens live so the extension can show
                    // thinking + answer token-by-token as they arrive.
                    stream: true,

                    // Ask thinking models (e.g. qwen3) to expose their
                    // reasoning trace as message.thinking chunks.
                    // (Resume keeps think on: Qwen continues reasoning
                    // from its partial output instead of restarting.)
                    think
                }),

                signal: controller.signal
            }
        );

        if (!response.ok) {

            if (response.status === 404) {
                throw new Error(
                    `Ollama model "${model}" not found. Run: ollama pull ${model}`
                );
            }

            throw new Error(
                `Ollama returned HTTP ${response.status}. Check that Ollama is running at ${url}.`
            );
        }

        if (!response.body) {
            throw new Error(
                `Ollama returned an empty response body at ${url}.`
            );
        }

        const reader =
            response.body.getReader();

        const decoder =
            new TextDecoder();

        let buffer = '';

        const applyChunk = (chunk: OllamaStreamChunk): void => {
            if (typeof chunk.error === 'string' && chunk.error) {
                throw new Error(`Ollama error: ${chunk.error}`);
            }
            const msg = chunk.message;
            if (!msg) {
                return;
            }
            if (typeof msg.thinking === 'string' && msg.thinking) {
                thinking += msg.thinking;
            }
            if (typeof msg.content === 'string' && msg.content) {
                content += msg.content;
            }
        };

        let streamDone = false;

        while (!streamDone) {

            const { done, value } =
                await reader.read();

            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {

                const text = line.trim();

                if (!text) {
                    continue;
                }

                let chunk: OllamaStreamChunk;

                try {
                    chunk = JSON.parse(text) as OllamaStreamChunk;
                } catch {
                    continue;
                }

                applyChunk(chunk);

                // Output is flowing — thinking time doesn't count.
                timers.refresh();

                if (chunk.done) {
                    streamDone = true;
                    break;
                }

                if (onToken) {
                    onToken(thinking, content);
                }
            }
        }

        const tail = buffer.trim();

        if (tail) {
            try {
                applyChunk(JSON.parse(tail) as OllamaStreamChunk);
            } catch {
                // Ignore trailing partial line.
            }
        }

        if (onToken) {
            onToken(thinking, content);
        }

        // Fallback: some models/versions embed <think>...</think> in content
        // instead of (or in addition to) the separate thinking field.
        const thinkMatch =
            content.match(/<think>([\s\S]*?)<\/think>/i);

        if (thinkMatch) {
            if (!thinking) {
                thinking = thinkMatch[1].trim();
            }
            content = content
                .replace(/<think>[\s\S]*?<\/think>/gi, '')
                .trim();
        }

        // Unclosed tag (truncated generation) — same handling.
        if (!thinking) {
            const openMatch =
                content.match(/<think>([\s\S]*)$/i);
            if (openMatch) {
                thinking = openMatch[1].trim();
                content = content
                    .replace(/<think>[\s\S]*$/i, '')
                    .trim();
            }
        }

        return { content, thinking };

    } catch (error) {

        if (
            token.isCancellationRequested && !timers.isTimedOut()
        ) {
            throw new Error(
                'Qwen request was cancelled.'
            );
        }

        if (
            timers.isTimedOut() ||
            (error instanceof Error && error.name === 'AbortError')
        ) {
            throw new QwenPartialError(
                timeoutMessage(
                    timers.wasIdle(),
                    Math.round(timeout / 1000),
                    Math.round(timeout * 4 / 1000),
                    url,
                    model
                ),
                thinking,
                content
            );
        }

        const message =
            error instanceof Error
                ? error.message
                : String(error);

        if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message)) {
            throw new Error(
                `Cannot reach Ollama at ${url}. Is Ollama running? Start it with "ollama serve", then run "ollama pull ${model}".`
            );
        }

        throw error instanceof Error
            ? error
            : new Error(message);

    } finally {

        timers.dispose();

        cancellationDisposable.dispose();
    }
}

export interface OllamaToolStep {
    content: string;
    thinking: string;
    toolCalls: LocalToolCall[];
    rawToolCalls: any[];
}

interface OllamaToolResponse {
    message?: {
        content?: string;
        thinking?: string;
        tool_calls?: any[];
    };
}

function parseToolCalls(raw: unknown): LocalToolCall[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const out: LocalToolCall[] = [];
    for (const item of raw) {
        const fn =
            (item as { function?: unknown }).function ??
            item;
        const rec = fn as Record<string, unknown>;
        const name =
            typeof rec.name === 'string'
                ? rec.name
                : '';
        if (!name) {
            continue;
        }
        let args: unknown = rec.arguments ?? {};
        if (typeof args === 'string') {
            try {
                args = JSON.parse(args);
            } catch {
                args = { _raw: args };
            }
        }
        out.push({ name, args });
    }
    return out;
}

/**
 * Text-format tool calls. Small local models often NEVER emit native
 * tool_calls (template quirks, deliberation loops) but WILL write a fenced
 * JSON block when told exactly how. Format:
 *   ```tool
 *   {"name": "local_write_file", "args": {"path": "TEST.md", "content": "hi"}}
 *   ```
 * Multiple blocks = multiple calls, in order.
 */
export function parseTextToolCalls(content: string): LocalToolCall[] {
    const out: LocalToolCall[] = [];
    const re = /```tool\s*([\s\S]*?)```/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        try {
            const obj = JSON.parse(m[1].trim()) as {
                name?: unknown;
                args?: unknown;
            };
            if (typeof obj.name === 'string' && obj.name) {
                out.push({
                    name: obj.name,
                    args: obj.args ?? {}
                });
            }
        } catch {
            // Malformed block — ignored (stuck logic handles no-call turns).
        }
    }
    return out;
}

/** Remove ```tool blocks so follow-up text stays clean for the lead. */
export function stripTextToolCalls(content: string): string {
    return content.replace(/```tool\s*[\s\S]*?```/gi, '').trim();
}

/**
 * One Ollama turn WITH tool definitions, STREAMED.
 * Thinking/content deltas go to onToken live (so the user sees Qwen think
 * during long agentic steps); tool_calls are complete in the final chunk.
 */
export async function askOllamaToolStep(
    system: string,
    history: any[],
    token: vscode.CancellationToken,
    timeoutMs: number,
    tools: LocalToolDef[],
    onToken?: OllamaTokenCallback,
    think = true,
    maxTokens = 0
): Promise<OllamaToolStep> {

    const { url, model } = getOllamaConfig();

    const controller =
        new AbortController();

    // Idle timeout = silence limit (resets on every token); absolute caps
    // the total step run. Thinking time itself never counts.
    const timers = createAbortTimers(controller, timeoutMs, timeoutMs * 4);

    const cancellationDisposable =
        token.onCancellationRequested(() => {
            controller.abort();
        });

    // Buffers outside try so a timeout carries partial output for resume.
    let thinking = '';
    let content = '';

    try {

        const response = await fetch(
            `${url}/api/chat`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: 'system', content: system },
                        ...history
                    ],
                    tools,
                    stream: true,
                    think,
                    // Cap output tokens per agentic step: bounds rambling on
                    // slow PCs (0 = uncapped). Cut-off steps return partial
                    // output, which the bridge resumes or guides past.
                    ...(maxTokens > 0
                        ? { options: { num_predict: maxTokens } }
                        : {})
                }),
                signal: controller.signal
            }
        );

        if (!response.ok) {
            if (response.status === 404) {
                throw new Error(
                    `Ollama model "${model}" not found. Run: ollama pull ${model}`
                );
            }
            throw new Error(
                `Ollama returned HTTP ${response.status}. Check that Ollama is running at ${url}.`
            );
        }

        if (!response.body) {
            throw new Error(
                `Ollama returned an empty response body at ${url}.`
            );
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        let buffer = '';
        let rawToolCalls: any[] = [];
        let streamDone = false;

        while (!streamDone) {

            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {

                const text = line.trim();

                if (!text) {
                    continue;
                }

                let chunk: OllamaToolResponse;

                try {
                    chunk = JSON.parse(text) as OllamaToolResponse;
                } catch {
                    continue;
                }

                const msg = chunk.message ?? {};

                if (typeof msg.thinking === 'string' && msg.thinking) {
                    thinking += msg.thinking;
                }
                if (typeof msg.content === 'string' && msg.content) {
                    content += msg.content;
                }
                if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                    rawToolCalls = msg.tool_calls;
                }

                // Output is flowing — thinking time doesn't count.
                timers.refresh();

                if ((chunk as { done?: boolean }).done) {
                    streamDone = true;
                    break;
                }

                if (onToken) {
                    onToken(thinking, content);
                }
            }
        }

        const tail = buffer.trim();

        if (tail) {
            try {
                const chunk = JSON.parse(tail) as OllamaToolResponse;
                const msg = chunk.message ?? {};
                if (typeof msg.thinking === 'string' && msg.thinking) {
                    thinking += msg.thinking;
                }
                if (typeof msg.content === 'string' && msg.content) {
                    content += msg.content;
                }
                if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                    rawToolCalls = msg.tool_calls;
                }
            } catch {
                // Ignore trailing partial line.
            }
        }

        if (onToken) {
            onToken(thinking, content);
        }

        return {
            content: content.trim(),
            thinking: thinking.trim(),
            toolCalls: parseToolCalls(rawToolCalls),
            rawToolCalls
        };

    } catch (error) {

        if (token.isCancellationRequested && !timers.isTimedOut()) {
            throw new Error('Qwen request was cancelled.');
        }
        if (
            timers.isTimedOut() ||
            (error instanceof Error && error.name === 'AbortError')
        ) {
            throw new QwenPartialError(
                timeoutMessage(
                    timers.wasIdle(),
                    Math.round(timeoutMs / 1000),
                    Math.round(timeoutMs * 4 / 1000),
                    url,
                    model
                ),
                thinking,
                content
            );
        }
        const message =
            error instanceof Error ? error.message : String(error);
        if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message)) {
            throw new Error(
                `Cannot reach Ollama at ${url}. Is Ollama running? Start it with "ollama serve", then run "ollama pull ${model}".`
            );
        }
        throw error instanceof Error ? error : new Error(message);

    } finally {
        timers.dispose();
        cancellationDisposable.dispose();
    }
}
