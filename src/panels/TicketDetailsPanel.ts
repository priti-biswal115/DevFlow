import * as vscode from 'vscode';
import { Ticket } from '../types/ticket';
import { FileDiscoveryService } from '../services/FileDiscoveryService';
import { CopilotService } from '../services/CopilotService';
import { ChangeApplyService } from '../services/ChangeApplyService';

export class TicketDetailsPanel {
    public static currentPanel: TicketDetailsPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _ticket: Ticket;
    private _cancellationTokenSource?: vscode.CancellationTokenSource;
    private _lastContextPackage: any;

    private constructor(panel: vscode.WebviewPanel, ticket: Ticket) {
        this._panel = panel;
        this._ticket = ticket;
        this._update();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'findRelevantFiles':
                        await this._handleFindRelevantFiles();
                        break;
                    case 'solveWithAgent':
                        await this._handleSolveWithAgent(message.relevantFiles);
                        break;
                    case 'confirmStartAgent':
                        await this._handleStartAgent();
                        break;
                    case 'applyChanges':
                        await this._handleApplyChanges(message.content);
                        break;
                    case 'reviewChanges':
                        await this._handleReviewChanges(message.content);
                        break;
                    case 'openInCopilotChat':
                        await this._handleOpenInCopilotChat();
                        break;
                    case 'cancelAgent':
                        if (this._cancellationTokenSource) {
                            this._cancellationTokenSource.cancel();
                        }
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    public static render(ticket: Ticket) {
        if (TicketDetailsPanel.currentPanel) {
            TicketDetailsPanel.currentPanel._panel.dispose();
        }

        const panel = vscode.window.createWebviewPanel(
            'ticketDetails',
            `DevFlow | Ticket #${ticket.id}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        TicketDetailsPanel.currentPanel = new TicketDetailsPanel(panel, ticket);
    }

    private async _handleFindRelevantFiles() {
        try {
            this._panel.webview.postMessage({ type: 'discoveringFiles' });
            const files = await FileDiscoveryService.findRelevantFiles(this._ticket);
            this._panel.webview.postMessage({ type: 'filesDiscovered', files });
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error finding relevant files: ${error.message}`);
            this._panel.webview.postMessage({ type: 'discoveryError', message: error.message });
        }
    }

    private async _handleSolveWithAgent(relevantFiles: any[]) {
        try {
            this._panel.webview.postMessage({ type: 'preparingContext' });
            
            // Read file contents for the selected relevant files
            const filesWithContents = await Promise.all(
                relevantFiles.map(async (f: any) => {
                    try {
                        const content = await vscode.workspace.fs.readFile(vscode.Uri.file(f.path));
                        return {
                            ...f,
                            content: Buffer.from(content).toString('utf-8')
                        };
                    } catch (err) {
                        return { ...f, content: 'Error reading file' };
                    }
                })
            );

            this._lastContextPackage = {
                ticket: {
                    id: this._ticket.id,
                    title: this._ticket.title,
                    description: this._ticket.description,
                },
                relevantFiles: filesWithContents
            };

            this._panel.webview.postMessage({ type: 'contextPrepared', payload: this._lastContextPackage });
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error preparing context: ${error.message}`);
        }
    }

    private async _handleStartAgent() {
        if (!this._lastContextPackage) return;

        this._cancellationTokenSource = new vscode.CancellationTokenSource();
        this._panel.webview.postMessage({ type: 'agentStarted' });

        try {
            await CopilotService.executeTicket(
                this._lastContextPackage,
                (chunk) => {
                    this._panel.webview.postMessage({ type: 'agentChunk', chunk });
                },
                this._cancellationTokenSource.token
            );
            this._panel.webview.postMessage({ type: 'agentCompleted' });
        } catch (error: any) {
            vscode.window.showErrorMessage(`Agent error: ${error.message}`);
            this._panel.webview.postMessage({ type: 'agentError', message: error.message });
        }
    }

    private async _handleApplyChanges(content: string) {
        try {
            const edits = await ChangeApplyService.parseEdits(content ?? '');
            if (edits.length === 0) {
                vscode.window.showWarningMessage(
                    'DevFlow: the agent response contained no file blocks to apply. Re-run the agent, or use "Continue in Copilot Chat".'
                );
                return;
            }

            await ChangeApplyService.apply(edits);
            this._panel.webview.postMessage({
                type: 'changesApplied',
                files: edits.map(e => e.relativePath)
            });

            const choice = await vscode.window.showInformationMessage(
                `DevFlow applied changes to ${edits.length} file(s). Changed lines are highlighted in green.`,
                'Keep',
                'Undo All'
            );
            if (choice === 'Undo All') {
                await ChangeApplyService.undoLast();
            } else if (choice === 'Keep') {
                ChangeApplyService.clearHighlights();
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`DevFlow: failed to apply changes. ${error.message}`);
        }
    }

    private async _handleReviewChanges(content: string) {
        try {
            const edits = await ChangeApplyService.parseEdits(content ?? '');
            if (edits.length === 0) {
                vscode.window.showWarningMessage('DevFlow: the agent response contained no file blocks to review.');
                return;
            }
            await ChangeApplyService.review(edits);
        } catch (error: any) {
            vscode.window.showErrorMessage(`DevFlow: failed to open the diff view. ${error.message}`);
        }
    }

    private async _handleOpenInCopilotChat() {
        const contextPackage = this._lastContextPackage ?? {
            ticket: { id: this._ticket.id, title: this._ticket.title, description: this._ticket.description },
            relevantFiles: []
        };
        const query = CopilotService.buildChatPrompt(contextPackage);

        try {
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                query,
                mode: 'agent'
            });
        } catch {
            try {
                await vscode.commands.executeCommand('workbench.action.chat.open', query);
            } catch {
                await vscode.env.clipboard.writeText(query);
                vscode.window.showWarningMessage(
                    'DevFlow: could not open Copilot Chat. The prompt was copied to your clipboard instead.'
                );
            }
        }
    }

    public dispose() {
        TicketDetailsPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }

    private _update() {
        const webview = this._panel.webview;
        webview.html = this._getHtmlForWebview();
    }

    private _getHtmlForWebview() {
        const t = this._ticket;
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DevFlow | Ticket #${t.id}</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
            display: flex;
            flex-direction: column;
            gap: 20px;
        }
        h1, h2, h3 { color: var(--vscode-editor-foreground); margin: 0; }
        .header { display: flex; flex-direction: column; gap: 8px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 20px; }
        .meta { display: flex; gap: 20px; font-size: 13px; color: var(--vscode-descriptionForeground); }
        .badge { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 2px 8px; border-radius: 12px; font-size: 11px; }
        
        .section {
            background: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        
        button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            align-self: flex-start;
        }
        button:hover { background: var(--vscode-button-hoverBackground); }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        
        .file-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
        .file-item { display: flex; justify-content: space-between; padding: 8px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
        .file-path { font-family: var(--vscode-editor-font-family); font-size: 12px; }
        .file-match { font-size: 12px; font-weight: bold; color: var(--vscode-charts-green); }
        
        pre { background: var(--vscode-editor-background); padding: 10px; border-radius: 4px; overflow: auto; font-family: var(--vscode-editor-font-family); font-size: 12px; border: 1px solid var(--vscode-panel-border); }
        .hidden { display: none !important; }
    </style>
</head>
<body>
    <div class="header">
        <h1>#${t.id} ${this._escapeHtml(t.title)}</h1>
        <div class="meta">
            <span><strong>Assigned To:</strong> ${this._escapeHtml(t.assignedTo)}</span>
            <span><strong>Created:</strong> ${new Date(t.createdDate).toLocaleString()}</span>
            <span class="badge">${this._escapeHtml(t.state)}</span>
        </div>
        <div style="margin-top: 10px; line-height: 1.5;">
            ${t.description}
        </div>
    </div>

    <!-- 1. Context Discovery -->
    <div class="section">
        <h2>1. Context Discovery</h2>
        <p>Find relevant files in the workspace based on the ticket details.</p>
        <button id="btnFindFiles">Find Relevant Files</button>
        <div id="discoveryStatus" class="hidden" style="color: var(--vscode-descriptionForeground); font-style: italic;">Searching...</div>
        <div id="fileResults" class="file-list hidden"></div>
    </div>

    <!-- 2. Agent Execution -->
    <div class="section">
        <h2>2. Agent Execution</h2>
        <p>Prepare the context package with the discovered files and ticket details for the AI Agent.</p>
        <button id="btnSolve" disabled>Solve With Agent</button>
        <div id="agentStatus" class="hidden" style="color: var(--vscode-descriptionForeground); font-style: italic;">Preparing context...</div>
        
        <div id="agentPayloadContainer" class="hidden">
            <h3 style="margin-bottom: 8px; font-size: 13px;">Prepared Context Payload:</h3>
            <pre id="agentPayload"></pre>
            <div style="margin-top: 10px; display: flex; gap: 10px;">
                <button id="btnConfirmAgent" style="background: var(--vscode-charts-green); color: white;">Confirm & Start Agent</button>
            </div>
        </div>

        <div id="agentOutputContainer" class="hidden" style="margin-top: 15px; border-top: 1px solid var(--vscode-panel-border); padding-top: 15px;">
            <h3>Agent Output</h3>
            <div id="streamingStatus" style="font-weight: bold; margin-bottom: 10px;">Status: Running...</div>
            <pre id="agentOutput" style="white-space: pre-wrap; word-wrap: break-word; min-height: 100px;"></pre>
            <div id="agentActions" class="hidden" style="margin-top: 10px; display: flex; gap: 10px; flex-wrap: wrap;">
                <button id="btnReviewChanges">Review Changes</button>
                <button id="btnApplyChanges" style="background: var(--vscode-charts-blue); color: white;">Apply Changes</button>
                <button id="btnCopilotChat" style="background: transparent; color: var(--vscode-textLink-foreground); border: 1px solid var(--vscode-panel-border);">Continue in Copilot Chat</button>
            </div>
            <div id="applyResult" class="hidden" style="margin-top: 10px; font-size: 12px; color: var(--vscode-charts-green);"></div>
        </div>
    </div>

    <!-- 3. PR Section -->
    <div class="section" style="opacity: 0.7;">
        <h2>3. PR Section</h2>
        <p>Enabled only after solution generated.</p>
        <button id="btnRaisePr" disabled>Raise PR</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        const btnFindFiles = document.getElementById('btnFindFiles');
        const discoveryStatus = document.getElementById('discoveryStatus');
        const fileResults = document.getElementById('fileResults');
        
        const btnSolve = document.getElementById('btnSolve');
        const agentStatus = document.getElementById('agentStatus');
        const agentPayloadContainer = document.getElementById('agentPayloadContainer');
        const agentPayload = document.getElementById('agentPayload');
        
        const btnConfirmAgent = document.getElementById('btnConfirmAgent');
        const agentOutputContainer = document.getElementById('agentOutputContainer');
        const streamingStatus = document.getElementById('streamingStatus');
        const agentOutput = document.getElementById('agentOutput');
        const agentActions = document.getElementById('agentActions');
        const btnReviewChanges = document.getElementById('btnReviewChanges');
        const btnApplyChanges = document.getElementById('btnApplyChanges');
        const btnCopilotChat = document.getElementById('btnCopilotChat');
        const applyResult = document.getElementById('applyResult');
        
        let discoveredFiles = [];
        let fullAgentResponse = '';

        btnFindFiles.addEventListener('click', () => {
            btnFindFiles.disabled = true;
            discoveryStatus.classList.remove('hidden');
            fileResults.classList.add('hidden');
            btnSolve.disabled = true;
            vscode.postMessage({ type: 'findRelevantFiles' });
        });

        btnSolve.addEventListener('click', () => {
            btnSolve.disabled = true;
            agentStatus.classList.remove('hidden');
            agentPayloadContainer.classList.add('hidden');
            agentOutputContainer.classList.add('hidden');
            vscode.postMessage({ type: 'solveWithAgent', relevantFiles: discoveredFiles });
        });

        btnConfirmAgent.addEventListener('click', () => {
            btnConfirmAgent.disabled = true;
            agentPayloadContainer.classList.add('hidden');
            agentOutputContainer.classList.remove('hidden');
            agentOutput.textContent = '';
            fullAgentResponse = '';
            streamingStatus.textContent = 'Status: Running...';
            agentActions.classList.add('hidden');
            vscode.postMessage({ type: 'confirmStartAgent' });
        });

        btnReviewChanges.addEventListener('click', () => {
            vscode.postMessage({ type: 'reviewChanges', content: fullAgentResponse });
        });

        btnApplyChanges.addEventListener('click', () => {
            vscode.postMessage({ type: 'applyChanges', content: fullAgentResponse });
        });

        btnCopilotChat.addEventListener('click', () => {
            vscode.postMessage({ type: 'openInCopilotChat' });
        });

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'discoveringFiles':
                    discoveryStatus.textContent = 'Searching workspace...';
                    break;
                case 'filesDiscovered':
                    discoveryStatus.classList.add('hidden');
                    btnFindFiles.disabled = false;
                    discoveredFiles = message.files;
                    
                    if (discoveredFiles.length === 0) {
                        fileResults.innerHTML = '<div style="color: var(--vscode-descriptionForeground);">No relevant files found.</div>';
                    } else {
                        fileResults.innerHTML = discoveredFiles.map(f => \`
                            <div class="file-item">
                                <span class="file-path">\${f.relativePath}</span>
                                <span class="file-match">\${Math.round(f.score * 100)}% Match</span>
                            </div>
                        \`).join('');
                        btnSolve.disabled = false;
                    }
                    fileResults.classList.remove('hidden');
                    break;
                case 'discoveryError':
                    discoveryStatus.textContent = 'Error: ' + message.message;
                    discoveryStatus.style.color = 'var(--vscode-errorForeground)';
                    btnFindFiles.disabled = false;
                    break;
                case 'preparingContext':
                    agentStatus.textContent = 'Preparing context package...';
                    break;
                case 'contextPrepared':
                    agentStatus.classList.add('hidden');
                    btnConfirmAgent.disabled = false;
                    agentPayload.textContent = JSON.stringify(message.payload, null, 2);
                    agentPayloadContainer.classList.remove('hidden');
                    break;
                case 'agentStarted':
                    break;
                case 'agentChunk':
                    fullAgentResponse += message.chunk;
                    agentOutput.textContent = fullAgentResponse;
                    // Auto-scroll to bottom
                    agentOutput.scrollTop = agentOutput.scrollHeight;
                    break;
                case 'agentCompleted':
                    streamingStatus.textContent = 'Status: Completed';
                    agentActions.classList.remove('hidden');
                    break;
                case 'changesApplied':
                    applyResult.textContent = 'Applied to: ' + message.files.join(', ');
                    applyResult.classList.remove('hidden');
                    break;
                case 'agentError':
                    streamingStatus.textContent = 'Status: Error';
                    streamingStatus.style.color = 'var(--vscode-errorForeground)';
                    agentOutput.textContent += '\\n\\nError: ' + message.message;
                    break;
            }
        });
    </script>
</body>
</html>`;
    }

    private _escapeHtml(str: string): string {
        if (!str) return '';
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}
