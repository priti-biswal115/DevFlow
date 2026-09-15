import * as vscode from 'vscode';
import { Ticket } from '../types/ticket';
import { DiscoveryResult, FileDiscoveryService, DiscoveredFile } from '../services/FileDiscoveryService';
import { CopilotService } from '../services/CopilotService';
import { ChangeApplyService } from '../services/ChangeApplyService';
import { GitService } from '../services/GitService';
import { BranchSessionService } from '../services/BranchSessionService';
import { PullRequestResult, PullRequestService } from '../services/PullRequestService';

export class TicketDetailsPanel {
    public static currentPanel: TicketDetailsPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _ticket: Ticket;
    private _cancellationTokenSource?: vscode.CancellationTokenSource;
    private _lastContextPackage: any;
    private _lastDiscoveryResult?: DiscoveryResult;
    private readonly _context: vscode.ExtensionContext;

    private constructor(panel: vscode.WebviewPanel, ticket: Ticket, context: vscode.ExtensionContext) {
        this._panel = panel;
        this._ticket = ticket;
        this._context = context;
        this._update();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'findRelevantFiles':
                        await this._handleFindRelevantFiles();
                        break;
                    case 'loadBranches':
                        await this._handleLoadBranches();
                        break;
                    case 'loadBranchSession':
                        await this._handleLoadBranchSession();
                        break;
                    case 'continueWorking':
                        await this._handleContinueWorking(message.branch);
                        break;
                    case 'createNewBranch':
                        this._panel.webview.postMessage({ type: 'newBranchMode' });
                        break;
                    case 'startWork':
                        await this._handleStartWork(message.baseBranch, message.workingBranch);
                        break;
                    case 'navigateMethod':
                        await this._handleNavigateMethod(message.file, message.line);
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
                    case 'loadPullRequestBranches':
                        await this._handleLoadPullRequestBranches();
                        break;
                    case 'createPullRequest':
                        await this._handleCreatePullRequest(message);
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

    public static render(ticket: Ticket, context: vscode.ExtensionContext) {
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

        TicketDetailsPanel.currentPanel = new TicketDetailsPanel(panel, ticket, context);
    }

    private async _handleLoadBranches() {
        try {
            const branches = await GitService.getBranches();
            this._panel.webview.postMessage({ type: 'branchesLoaded', branches });
        } catch (error: any) {
            this._panel.webview.postMessage({ type: 'branchError', message: error.message });
        }
    }

    private async _handleLoadBranchSession() {
        try {
            const branch = await BranchSessionService.getTicketBranch(this._ticket.id);
            this._panel.webview.postMessage({ type: 'branchSessionLoaded', branch });
        } catch (error: any) {
            this._panel.webview.postMessage({ type: 'branchSessionError', message: error.message });
        }
    }

    private async _handleContinueWorking(branch: string) {
        try {
            await GitService.checkoutBranch(branch);
            this._panel.webview.postMessage({
                type: 'workReady',
                baseBranch: branch,
                workingBranch: branch
            });
        } catch (error: any) {
            this._panel.webview.postMessage({ type: 'branchError', message: error.message });
        }
    }

    private async _handleStartWork(baseBranch: string, workingBranch: string) {
        if (!baseBranch || !workingBranch.trim()) {
            this._panel.webview.postMessage({ type: 'branchError', message: 'Select a base branch and enter a new branch name.' });
            return;
        }

        try {
            await GitService.startWork(baseBranch, workingBranch.trim());
            await BranchSessionService.saveTicketBranch(this._ticket.id, workingBranch.trim());
            this._panel.webview.postMessage({
                type: 'workReady',
                baseBranch,
                workingBranch: workingBranch.trim()
            });
        } catch (error: any) {
            this._panel.webview.postMessage({ type: 'branchError', message: error.message });
        }
    }

    private async _handleFindRelevantFiles() {
        try {
            this._panel.webview.postMessage({ type: 'discoveringFiles' });
            const discovery = await FileDiscoveryService.findRelevantFiles(this._ticket);
            this._lastDiscoveryResult = discovery;
            this._panel.webview.postMessage({
                type: 'filesDiscovered',
                files: discovery.files,
                reasoning: discovery.reasoning
            });
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error finding relevant files: ${error.message}`);
            this._panel.webview.postMessage({ type: 'discoveryError', message: error.message });
        }
    }

    private async _handleNavigateMethod(file: string, line: number) {
        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
            const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
            const position = new vscode.Position(Math.max(0, line - 1), 0);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
            editor.selection = new vscode.Selection(position, position);
        } catch (error: any) {
            vscode.window.showErrorMessage(`DevFlow: could not open method location. ${error.message}`);
        }
    }

    private async _handleLoadPullRequestBranches() {
        try {
            const [sourceBranch, branches] = await Promise.all([
                PullRequestService.getCurrentBranch(),
                PullRequestService.getAvailableTargetBranches()
            ]);
            this._panel.webview.postMessage({ type: 'pullRequestBranchesLoaded', sourceBranch, branches });
        } catch (error: any) {
            this._panel.webview.postMessage({ type: 'pullRequestError', message: error.message });
        }
    }

    private async _handleCreatePullRequest(message: any) {
        try {
            const result = await vscode.commands.executeCommand<PullRequestResult>('devflow.createPullRequest', {
                ticket: this._ticket,
                input: {
                    sourceBranch: message.sourceBranch,
                    targetBranch: message.targetBranch,
                    title: message.title,
                    description: message.description
                }
            });
            this._panel.webview.postMessage({ type: 'pullRequestCreated', result });
            vscode.window.showInformationMessage(
                result.url ? `Pull request created: ${result.url}` : 'Pull request created successfully.'
            );
        } catch (error: any) {
            this._panel.webview.postMessage({ type: 'pullRequestError', message: error.message });
            vscode.window.showErrorMessage(`DevFlow: ${error.message}`);
        }
    }

    private async _handleSolveWithAgent(relevantFiles: DiscoveredFile[]) {
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
                relevantFiles: filesWithContents,
                symbols: this._lastDiscoveryResult?.symbols ?? relevantFiles.flatMap((file) => file.matchedSymbols),
                methods: this._lastDiscoveryResult?.methods ?? relevantFiles.flatMap((file) => file.relevantMethods),
                reasoning: this._lastDiscoveryResult?.reasoning ?? []
            };

            this._panel.webview.postMessage({ type: 'contextPrepared', payload: this._lastContextPackage });
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error preparing context: ${error.message}`);
        }
    }

    private async _handleStartAgent() {
        if (!this._lastContextPackage) {
            return;
        }

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

        select, input, textarea {
            color: var(--vscode-input-foreground);
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            padding: 6px 8px;
            border-radius: 3px;
            font-size: 13px;
        }
        textarea { min-height: 130px; resize: vertical; font-family: var(--vscode-font-family); line-height: 1.45; }
        label { display: flex; flex-direction: column; gap: 6px; font-weight: 600; }

        #newBranchForm {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .branch-actions {
            margin-top: 16px;
        }

        .branch-actions button {
            min-width: 120px;
        }
        
        .file-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
        .file-item { display: flex; justify-content: space-between; padding: 8px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
        .file-path { font-family: var(--vscode-editor-font-family); font-size: 12px; }
        .file-match { font-size: 12px; font-weight: bold; color: var(--vscode-charts-green); }
        .method-list { margin: 4px 0 0 16px; font-size: 12px; }
        .method-link { color: var(--vscode-textLink-foreground); cursor: pointer; }
        .reason-list { margin: 4px 0 0 16px; font-size: 12px; color: var(--vscode-descriptionForeground); }

        .pr-form {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .pr-form select, .pr-form input, .pr-form textarea {
            width: 100%;
        }

        .pr-actions {
            margin-top: 8px;
        }
        
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

    <!-- 1. Branch Setup -->
    <div class="section">
        <h2>1. Branch Setup</h2>
        <div id="existingBranch" class="hidden">
            <strong>Current Working Branch:</strong> <span id="currentBranch"></span>
            <div style="display: flex; gap: 8px; margin-top: 8px;">
                <button id="btnContinueWorking">Continue Working</button>
                <button id="btnCreateNewBranch">Create New Branch</button>
            </div>
        </div>
        <div id="newBranchForm">
            <label>Base Branch
                <select id="baseBranch">
                    <option value="">Loading branches...</option>
                </select>
            </label>

            <label>New Branch Name
                <input id="workingBranch" type="text" value="feature-${t.id}-${this._slugify(t.title)}" />
            </label>

            <div class="branch-actions">
                <button id="btnStartWork" disabled>
                    Start Work
                </button>
            </div>
        </div>
        <div id="branchStatus" style="color: var(--vscode-descriptionForeground);">Loading local branches...</div>
    </div>

    <!-- 1. Context Discovery -->
    <div class="section">
        <h2>1. Context Discovery</h2>
        <p>Find relevant files in the workspace based on the ticket details.</p>
        <button id="btnFindFiles" disabled>Find Relevant Files</button>
        <div id="discoveryStatus" class="hidden" style="color: var(--vscode-descriptionForeground); font-style: italic;">Searching...</div>
        <div id="fileResults" class="file-list hidden"></div>
    </div>

    <!-- 2. Agent Execution -->
    <div class="section">
        <h2>2. Agent Execution</h2>
        <p>Prepare the context package with the discovered files and ticket details for the AI Agent.</p>
        <button id="btnSolve" disabled>Start With Agent</button>
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

    <!-- 3. Pull Request -->
    <div class="section">
        <h2>3. Pull Request</h2>
        <div class="pr-form">
        <label>Source Branch
            <input id="prSourceBranch" type="text" readonly placeholder="Loading current branch..." />
        </label>
        <label>Target Branch
            <select id="prTargetBranch">
                <option value="">Loading branches...</option>
            </select>
        </label>
        <label>PR Title
            <input id="prTitle" type="text" value="${this._escapeHtml(`Fix #${t.id}: ${t.title}`)}" />
        </label>
        <label>PR Description
            <textarea id="prDescription" rows="5">${this._escapeHtml(this._prDescription())}</textarea>
        </label>
        <div class="pr-actions">
            <button id="btnRaisePr" disabled>Create Pull Request</button>
        </div>
        </div>
        <div id="prStatus" style="color: var(--vscode-descriptionForeground);">Start work, then create a pull request when your changes are ready.</div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        const btnFindFiles = document.getElementById('btnFindFiles');
        const discoveryStatus = document.getElementById('discoveryStatus');
        const fileResults = document.getElementById('fileResults');
        const baseBranch = document.getElementById('baseBranch');
        const workingBranch = document.getElementById('workingBranch');
        const btnStartWork = document.getElementById('btnStartWork');
        const branchStatus = document.getElementById('branchStatus');
        const existingBranch = document.getElementById('existingBranch');
        const currentBranch = document.getElementById('currentBranch');
        const newBranchForm = document.getElementById('newBranchForm');
        const btnContinueWorking = document.getElementById('btnContinueWorking');
        const btnCreateNewBranch = document.getElementById('btnCreateNewBranch');
        
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
        const prSourceBranch = document.getElementById('prSourceBranch');
        const prTargetBranch = document.getElementById('prTargetBranch');
        const prTitle = document.getElementById('prTitle');
        const prDescription = document.getElementById('prDescription');
        const btnRaisePr = document.getElementById('btnRaisePr');
        const prStatus = document.getElementById('prStatus');
        
        let discoveredFiles = [];
        let fullAgentResponse = '';
        let branchReady = false;

        function refreshPrButton() {
            btnRaisePr.disabled = !branchReady || !prSourceBranch.value || !prTargetBranch.value;
        }

        vscode.postMessage({ type: 'loadBranches' });
        vscode.postMessage({ type: 'loadBranchSession' });
        vscode.postMessage({ type: 'loadPullRequestBranches' });

        btnContinueWorking.addEventListener('click', () => {
            btnContinueWorking.disabled = true;
            branchStatus.textContent = 'Checking out existing working branch...';
            vscode.postMessage({ type: 'continueWorking', branch: currentBranch.textContent });
        });

        btnCreateNewBranch.addEventListener('click', () => {
            existingBranch.classList.add('hidden');
            newBranchForm.classList.remove('hidden');
        });

        baseBranch.addEventListener('change', () => {
            btnStartWork.disabled = !baseBranch.value || !workingBranch.value.trim();
        });

        workingBranch.addEventListener('input', () => {
            btnStartWork.disabled = !baseBranch.value || !workingBranch.value.trim();
        });

        btnStartWork.addEventListener('click', () => {
            btnStartWork.disabled = true;
            branchStatus.textContent = 'Checking out base branch, pulling latest, and creating working branch...';
            vscode.postMessage({
                type: 'startWork',
                baseBranch: baseBranch.value,
                workingBranch: workingBranch.value
            });
        });

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

        btnRaisePr.addEventListener('click', () => {
            btnRaisePr.disabled = true;
            prStatus.textContent = 'Creating pull request...';
            vscode.postMessage({
                type: 'createPullRequest',
                sourceBranch: prSourceBranch.value,
                targetBranch: prTargetBranch.value,
                title: prTitle.value,
                description: prDescription.value
            });
        });

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'branchesLoaded':
                    baseBranch.innerHTML = message.branches.map(branch =>
                        '<option value="' + escapeHtml(branch) + '">' + escapeHtml(branch) + '</option>'
                    ).join('');
                    btnStartWork.disabled = message.branches.length === 0 || !workingBranch.value.trim();
                    branchStatus.textContent = message.branches.length
                        ? 'Select a successful base branch and start work.'
                        : 'No local branches found.';
                    break;
                case 'branchSessionLoaded':
                    if (message.branch) {
                        currentBranch.textContent = message.branch;
                        existingBranch.classList.remove('hidden');
                        newBranchForm.classList.add('hidden');
                        branchStatus.textContent = 'Continue working on the existing branch or create a new one.';
                    }
                    break;
                case 'branchSessionError':
                    branchStatus.textContent = message.message;
                    break;
                case 'newBranchMode':
                    branchStatus.textContent = 'Select a base branch and start a new branch.';
                    break;
                case 'workReady':
                    branchStatus.textContent = 'Selected Base Branch: ' + message.baseBranch
                        + ' | Working Branch: ' + message.workingBranch
                        + ' | Status: Ready';
                    branchStatus.style.color = 'var(--vscode-charts-green)';
                    branchReady = true;
                    prSourceBranch.value = message.workingBranch;
                    refreshPrButton();
                    prStatus.textContent = 'Create a pull request when your manual or agent changes are ready.';
                    btnFindFiles.disabled = false;
                    break;
                case 'branchError':
                    branchStatus.textContent = 'Branch setup failed: ' + message.message;
                    branchStatus.style.color = 'var(--vscode-errorForeground)';
                    btnStartWork.disabled = false;
                    break;
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
                                <div>
                                    <div class="file-path">\${f.relativePath}</div>
                                    <div class="method-list">\${(f.relevantMethods || []).map(m =>
                                        \`<div class="method-link" data-file="\${escapeHtml(m.file)}" data-line="\${m.line}">• \${escapeHtml(m.name)}()</div>\`
                                    ).join('')}</div>
                                    <div class="reason-list">\${(f.reasoning || []).map(reason =>
                                        \`<div>• \${escapeHtml(reason)}</div>\`
                                    ).join('')}</div>
                                </div>
                                <span class="file-match">\${Math.round(f.score * 100)}% Match</span>
                            </div>
                        \`).join('');
                        fileResults.querySelectorAll('.method-link').forEach(method => {
                            method.addEventListener('click', () => vscode.postMessage({
                                type: 'navigateMethod',
                                file: method.dataset.file,
                                line: Number(method.dataset.line)
                            }));
                        });
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
                case 'pullRequestBranchesLoaded':
                    prSourceBranch.value = message.sourceBranch || '';
                    prTargetBranch.innerHTML = message.branches
                        .filter(branch => branch !== message.sourceBranch)
                        .map(branch => '<option value="' + escapeHtml(branch) + '">' + escapeHtml(branch) + '</option>')
                        .join('');
                    refreshPrButton();
                    break;
                case 'pullRequestCreated':
                    btnRaisePr.disabled = false;
                    prStatus.textContent = message.result.url
                        ? 'Pull request created: ' + message.result.url
                        : 'Pull request created successfully.';
                    prStatus.style.color = 'var(--vscode-charts-green)';
                    break;
                case 'pullRequestError':
                    btnRaisePr.disabled = false;
                    prStatus.textContent = 'Pull request failed: ' + message.message;
                    prStatus.style.color = 'var(--vscode-errorForeground)';
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

        function escapeHtml(value) {
            return String(value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }
    </script>
</body>
</html>`;
    }

    private _escapeHtml(str: string): string {
        if (!str) {
            return '';
        }
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    private _slugify(str: string): string {
        return str
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 50);
    }

    private _prDescription(): string {
        const summary = this._ticket.title.replace(/^#?\d+\s*/, '').trim();
        return `Ticket: #${this._ticket.id}\n\nSummary:\n${summary}.\n\nFiles Changed:\n- Add files after reviewing changes\n\nTesting:\n- Application loads successfully\n- Relevant behavior verified\n\nImpact:\nUI/code update for the selected ticket\n\nDetails:\n${this._ticket.description
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()}`;
    }
}
