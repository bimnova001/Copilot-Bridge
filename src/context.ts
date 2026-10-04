import * as vscode from 'vscode';
import * as path from 'path';

const MAX_FILES = 100;
const MAX_FILE_SIZE = 20000;

const IGNORED_DIRS = new Set([
    'node_modules',
    '.git',
    'dist',
    'out',
    'build',
    '.vscode'
]);

const TEXT_EXTENSIONS = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.json',
    '.py',
    '.c',
    '.cpp',
    '.h',
    '.hpp',
    '.java',
    '.cs',
    '.go',
    '.rs',
    '.php',
    '.html',
    '.css',
    '.scss',
    '.md',
    '.txt',
    '.yaml',
    '.yml',
    '.xml',
    '.sh',
    '.bat',
    '.ps1'
]);

export interface WorkspaceContext {
    workspacePath: string;
    files: string[];
    activeFile?: string;
    selectedCode?: string;
}

function isTextFile(uri: vscode.Uri): boolean {
    const extension = path.extname(uri.fsPath).toLowerCase();
    return TEXT_EXTENSIONS.has(extension);
}

function isIgnored(uri: vscode.Uri): boolean {
    const parts = uri.fsPath.split(path.sep);

    return parts.some(part =>
        IGNORED_DIRS.has(part)
    );
}

export async function getWorkspaceContext(): Promise<WorkspaceContext> {

    const workspaceFolder =
        vscode.workspace.workspaceFolders?.[0];

    if (!workspaceFolder) {
        return {
            workspacePath: '',
            files: []
        };
    }

    const files =
        await vscode.workspace.findFiles(
            '**/*',
            '**/{node_modules,.git,dist,out,build}/**',
            MAX_FILES
        );

    const relativeFiles = files
        .filter(uri => !isIgnored(uri))
        .filter(uri => isTextFile(uri))
        .map(uri =>
            vscode.workspace.asRelativePath(uri)
        )
        .sort();

    const editor =
        vscode.window.activeTextEditor;

    let activeFile: string | undefined;
    let selectedCode: string | undefined;

    if (editor) {

        activeFile =
            vscode.workspace.asRelativePath(
                editor.document.uri
            );

        const selection =
            editor.selection;

        if (!selection.isEmpty) {

            selectedCode =
                editor.document.getText(selection);

            if (selectedCode.length > MAX_FILE_SIZE) {
                selectedCode =
                    selectedCode.slice(
                        0,
                        MAX_FILE_SIZE
                    ) +
                    '\n...[selection truncated]';
            }
        }
    }

    return {
        workspacePath:
            workspaceFolder.uri.fsPath,

        files:
            relativeFiles,

        activeFile,

        selectedCode
    };
}

export function formatWorkspaceContext(
    context: WorkspaceContext,
    maxFiles = 100
): string {

    if (!context.workspacePath) {
        return `
WORKSPACE:

No workspace is currently open.
`;
    }

    let result = `
WORKSPACE:

Path:
${context.workspacePath}

Files:
`;

    if (context.files.length === 0) {
        result += '(No supported text files found.)';
    } else {
        // Small local models drown in giant file lists: cap the listing
        // (Qwen has search tools to look deeper when needed).
        const shown = context.files.slice(0, maxFiles);
        result += shown
            .map(file => `- ${file}`)
            .join('\n');
        if (context.files.length > shown.length) {
            result += `\n(...and ${context.files.length - shown.length} more files — use search tools to explore)`;
        }
    }

    if (context.activeFile) {
        result += `

ACTIVE FILE:

${context.activeFile}`;
    }

    if (context.selectedCode) {
        result += `

SELECTED CODE:

\`\`\`
${context.selectedCode}
\`\`\``;
    }

    return result;
}