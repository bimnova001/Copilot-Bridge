import * as vscode from 'vscode';
import { runAgent, getLastThinking } from './orchestrator';

const PARTICIPANT_ID =
    'ai-copilot-bridge.multi';

export function activate(
    context: vscode.ExtensionContext
) {

    console.log(
        '[AI Copilot Bridge] Activating...'
    );

    const handler:
        vscode.ChatRequestHandler =
        async (
            request,
            chatContext,
            stream,
            token
        ) => {

            try {

                await runAgent(
                    request,
                    chatContext,
                    stream,
                    token
                );

            } catch (error) {

                if (
                    token.isCancellationRequested
                ) {
                    stream.markdown(
                        '\n\nRequest cancelled.\n'
                    );
                    return;
                }

                console.error(
                    '[AI Copilot Bridge]',
                    error
                );

                const message =
                    error instanceof Error
                        ? error.message
                        : String(error);

                if (/No Copilot language model|sign in to GitHub Copilot/i.test(message)) {
                    stream.markdown(
                        '**AI Copilot Bridge:** No Copilot model available.\n\n' +
                        '1. Install the GitHub Copilot and Copilot Chat extensions.\n' +
                        '2. Sign in to GitHub with an active Copilot subscription.\n' +
                        '3. Try `@multi hello` again.\n'
                    );
                    return;
                }

                stream.markdown(
                    `**AI Copilot Bridge error:** ${message}`
                );
            }
        };

    const participant =
        vscode.chat.createChatParticipant(
            PARTICIPANT_ID,
            handler
        );

    participant.iconPath =
        new vscode.ThemeIcon('hubot');

    context.subscriptions.push(
        participant
    );

    // Opens the last Qwen thinking trace in an editor (used by the
    // "+ Thinking" button in chat). Stable API only — no proposed API.
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'ai-copilot-bridge.showLastThinking',
            async () => {
                const last = getLastThinking();
                if (!last.text.trim()) {
                    await vscode.window.showInformationMessage(
                        'No Qwen thinking yet. Ask @multi something that uses the local AI first.'
                    );
                    return;
                }
                const doc =
                    await vscode.workspace.openTextDocument({
                        language: 'markdown',
                        content:
                            `# Qwen thinking\n\n` +
                            `- Model: ${last.model || '(unknown)'}\n` +
                            `- Time: ${new Date(last.at).toLocaleString()}\n` +
                            `- Chars: ${last.text.length}\n\n` +
                            `---\n\n${last.text}\n`
                    });
                await vscode.window.showTextDocument(doc, { preview: true });
            }
        )
    );

    console.log(
        '[AI Copilot Bridge] Participant registered'
    );
}

export function deactivate() {}