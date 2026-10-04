import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { LocalToolCall, LocalToolDef } from './ollama';

// Built-in BASIC tools for the LOCAL model (Qwen via Ollama).
//
// Why do these exist ALONGSIDE Copilot tools? Some machines genuinely have
// no file-writing Copilot tool registered (only notebooks/find/tools-search),
// and then Qwen correctly concludes "I cannot create files" and stalls.
// These six Node-based tools are ALWAYS available (sandboxed to the workspace)
// so basic read/write always works; Copilot tools stay as the rich extra set.
// Mutating basics go through the same lead-approval gate in the orchestrator.

/** Resolve a path inside the workspace root. Throws if escaping. */
function sandboxPath(workspaceRoot: string, p: string): string {
    const abs = path.resolve(workspaceRoot, p);
    const rel = path.relative(workspaceRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`Path escapes workspace root: ${p}`);
    }
    return abs;
}

function strArg(args: unknown, key: string, fallback = ''): string {
    if (args && typeof args === 'object') {
        const v = (args as Record<string, unknown>)[key];
        if (typeof v === 'string') {
            return v;
        }
        if (typeof v === 'number' || typeof v === 'boolean') {
            return String(v);
        }
    }
    return fallback;
}

const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'out', 'build', '.vscode', '__pycache__'
]);

const CODE_EXT = new Set([
    'py', 'js', 'ts', 'tsx', 'jsx', 'java', 'cs', 'go', 'rs',
    'c', 'cpp', 'h', 'hpp', 'rb', 'php', 'swift', 'kt', 'sql',
    'html', 'css', 'scss', 'sh', 'ps1', 'bat'
]);

const FENCE_OK_EXT = new Set([
    ...CODE_EXT,
    'json', 'yaml', 'yml', 'toml', 'xml'
]);

const LANG_TAGS = new Set([
    'python', 'javascript', 'js', 'typescript', 'ts', 'tsx', 'jsx',
    'json', 'java', 'csharp', 'c#', 'c++', 'cpp', 'c', 'go', 'rust',
    'ruby', 'php', 'swift', 'kotlin', 'sql', 'html', 'css', 'xml',
    'yaml', 'bash', 'sh', 'shell', 'powershell', 'ps1', 'plaintext', 'text'
]);

/**
 * Models love to wrap file content in ``` fences or a bare language tag
 * ("python\n# ui.py..."). That garbage must never reach disk. Markdown/text
 * docs are left untouched (their fences are real content).
 */
export function cleanFileContent(
    content: string,
    filename: string
): { text: string; cleaned: boolean } {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    if (!FENCE_OK_EXT.has(ext)) {
        return { text: content, cleaned: false };
    }

    let text = content;
    let cleaned = false;

    const full = text.match(/^```[\w+#-]*\r?\n([\s\S]*?)\r?\n```\s*$/);
    if (full) {
        text = full[1];
        cleaned = true;
    } else {
        const lines = text.split('\n');
        if (/^```[\w+#-]*\s*$/.test(lines[0] ?? '')) {
            lines.shift();
            cleaned = true;
        }
        if (lines.length > 0 && /^```\s*$/.test(lines[lines.length - 1] ?? '')) {
            lines.pop();
            cleaned = true;
        }
        text = lines.join('\n');
    }

    if (CODE_EXT.has(ext)) {
        const parts = text.split('\n');
        if (LANG_TAGS.has((parts[0] ?? '').trim().toLowerCase())) {
            text = parts.slice(1).join('\n').replace(/^\n+/, '');
            cleaned = true;
        }
    }

    return { text, cleaned };
}

const TEXT_EXT = /\.(ts|js|tsx|jsx|json|md|txt|py|java|cs|go|rs|c|cpp|h|hpp|yaml|yml|toml|xml|html|css|scss|sh|bat|ps1|java|kt|swift|rb|php|sql)$/i;

export function getLocalToolDefs(): LocalToolDef[] {
    return [
        {
            type: 'function',
            function: {
                name: 'local_read_file',
                description:
                    'ALWAYS AVAILABLE. Read a text file. Path relative to workspace root, e.g. "src/index.ts". Read-only, runs freely.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Relative file path.' }
                    },
                    required: ['path']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'local_list_dir',
                description:
                    'ALWAYS AVAILABLE. List files in a directory relative to workspace root. Use "." for root. Read-only, runs freely.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Relative dir path.' }
                    },
                    required: ['path']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'local_search',
                description:
                    'ALWAYS AVAILABLE. Search file contents with a regex pattern. Read-only, runs freely.',
                parameters: {
                    type: 'object',
                    properties: {
                        pattern: { type: 'string', description: 'Regex to search for.' },
                        dir: { type: 'string', description: 'Optional relative subdir.' }
                    },
                    required: ['pattern']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'local_write_file',
                description:
                    'ALWAYS AVAILABLE. Create or OVERWRITE a text file relative to workspace root. Use this to create files like TEST.md. MUTATING — needs approval.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Relative file path, e.g. "TEST.md".' },
                        content: { type: 'string', description: 'Full file content.' }
                    },
                    required: ['path', 'content']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'local_edit_file',
                description:
                    'ALWAYS AVAILABLE. Replace first occurrence of oldText with newText in a file. MUTATING — needs approval.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        oldText: { type: 'string' },
                        newText: { type: 'string' }
                    },
                    required: ['path', 'oldText', 'newText']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'local_run',
                description:
                    'ALWAYS AVAILABLE. Run a shell command with workspace root as cwd. DANGEROUS — needs approval and may ask the user.',
                parameters: {
                    type: 'object',
                    properties: {
                        command: { type: 'string', description: 'Shell command.' }
                    },
                    required: ['command']
                }
            }
        }
    ];
}

async function searchCode(
    root: string,
    pattern: string,
    subdir: string
): Promise<string> {
    const start = subdir
        ? sandboxPath(root, subdir)
        : root;
    let regex: RegExp;
    try {
        regex = new RegExp(pattern, 'i');
    } catch {
        throw new Error(`Invalid regex pattern: ${pattern}`);
    }
    const hits: string[] = [];
    const MAX_HITS = 50;
    let filesScanned = 0;
    const MAX_FILES = 2000;

    async function walk(dir: string): Promise<void> {
        if (hits.length >= MAX_HITS || filesScanned >= MAX_FILES) {
            return;
        }
        let entries;
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (hits.length >= MAX_HITS || filesScanned >= MAX_FILES) {
                return;
            }
            const fp = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (!SKIP_DIRS.has(e.name)) {
                    await walk(fp);
                }
                continue;
            }
            if (!TEXT_EXT.test(e.name)) {
                continue;
            }
            filesScanned++;
            let text: string;
            try {
                const stat = await fs.promises.stat(fp);
                if (stat.size > 200000) {
                    continue;
                }
                text = await fs.promises.readFile(fp, 'utf8');
            } catch {
                continue;
            }
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                // Reset regex state for global safety (non-global here, fine).
                if (regex.test(lines[i])) {
                    hits.push(
                        `${path.relative(root, fp)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`
                    );
                    if (hits.length >= MAX_HITS) {
                        return;
                    }
                }
            }
        }
    }

    await walk(start);
    if (hits.length === 0) {
        return `(no matches for /${pattern}/ under ${subdir || '.'}, scanned ${filesScanned} files)`;
    }
    return hits.join('\n');
}

// Commands that are never allowed, even with approval.
const COMMAND_DENY = [
    /\brm\s+-rf?\s+[\/~]/i,
    /\bformat\b/i,
    /\bmkfs\b/i,
    /\bshutdown\b/i,
    /\breboot\b/i,
    /:\(\)\s*\{/
];

function runCommand(
    cmd: string,
    cwd: string,
    timeoutMs: number
): Promise<string> {
    for (const deny of COMMAND_DENY) {
        if (deny.test(cmd)) {
            throw new Error(
                `Command blocked by safety denylist: ${cmd.slice(0, 100)}`
            );
        }
    }
    const isWin = process.platform === 'win32';
    return new Promise((resolve, reject) => {
        execFile(
            isWin ? 'cmd.exe' : '/bin/sh',
            isWin ? ['/d', '/s', '/c', cmd] : ['-c', cmd],
            { cwd, timeout: timeoutMs, maxBuffer: 1024 * 500 },
            (error, stdout, stderr) => {
                const out = (stdout + (stderr ? `\n[stderr]\n${stderr}` : ''))
                    .slice(0, 8000);
                if (error) {
                    reject(new Error(
                        `Command exited with error: ${error.message}\nOutput:\n${out}`
                    ));
                } else {
                    resolve(out.trim() || '(command produced no output)');
                }
            }
        );
    });
}

/** Execute a local_* tool. Workspace root MUST be set (sandbox enforced). */
export async function runLocalTool(
    call: LocalToolCall,
    workspaceRoot: string
): Promise<string> {
    if (!workspaceRoot) {
        throw new Error('No workspace open — local file tools unavailable.');
    }
    switch (call.name) {
        case 'local_read_file': {
            const p = strArg(call.args, 'path');
            if (!p) {
                throw new Error('local_read_file needs "path".');
            }
            const abs = sandboxPath(workspaceRoot, p);
            const stat = await fs.promises.stat(abs);
            if (stat.size > 200000) {
                throw new Error(`File too large (${stat.size} bytes, max 200000).`);
            }
            return await fs.promises.readFile(abs, 'utf8');
        }
        case 'local_list_dir': {
            const p = strArg(call.args, 'path', '.');
            const abs = sandboxPath(workspaceRoot, p);
            const entries = await fs.promises.readdir(abs, { withFileTypes: true });
            const lines = entries.map(e =>
                e.isDirectory() ? `${e.name}/` : e.name
            );
            return lines.join('\n') || '(empty directory)';
        }
        case 'local_search': {
            const pattern = strArg(call.args, 'pattern');
            if (!pattern) {
                throw new Error('local_search needs "pattern".');
            }
            return await searchCode(
                workspaceRoot,
                pattern,
                strArg(call.args, 'dir', '')
            );
        }
        case 'local_write_file': {
            const p = strArg(call.args, 'path');
            const content = strArg(call.args, 'content');
            if (!p) {
                throw new Error('local_write_file needs "path".');
            }
            const abs = sandboxPath(workspaceRoot, p);
            await fs.promises.mkdir(path.dirname(abs), { recursive: true });
            const cleaned = cleanFileContent(content, p);
            await fs.promises.writeFile(abs, cleaned.text, 'utf8');
            return `Wrote ${cleaned.text.length} chars to ${abs}` +
                (cleaned.cleaned ? ' (stripped markdown fence/language tag)' : '');
        }
        case 'local_edit_file': {
            const p = strArg(call.args, 'path');
            if (!p) {
                throw new Error('local_edit_file needs "path".');
            }
            const abs = sandboxPath(workspaceRoot, p);
            const current = await fs.promises.readFile(abs, 'utf8');
            const oldText = strArg(call.args, 'oldText');
            if (!current.includes(oldText)) {
                throw new Error('oldText not found in file — no changes made.');
            }
            const newRaw = strArg(call.args, 'newText');
            const cleaned = cleanFileContent(newRaw, p);
            await fs.promises.writeFile(
                abs,
                current.replace(oldText, cleaned.text),
                'utf8'
            );
            return `Edited ${abs}.` +
                (cleaned.cleaned ? ' (stripped markdown fence/language tag)' : '');
        }
        case 'local_run': {
            const cmd = strArg(call.args, 'command');
            if (!cmd) {
                throw new Error('local_run needs "command".');
            }
            return await runCommand(cmd, workspaceRoot, 60000);
        }
        default:
            throw new Error(`Unknown local tool: ${call.name}`);
    }
}
