import * as vscode from 'vscode';
import { AdoService } from './services/AdoService';
import { TicketService } from './services/TicketService';
import { CodeReviewService } from './services/CodeReviewService';
import { Ticket } from './types/ticket';

export class DevFlowViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'devflow.mainView';

    private _view?: vscode.WebviewView;
    private _connected = false;

    constructor(private readonly context: vscode.ExtensionContext) {
    }

    // ── Auto reconnect ─────────────────────────────────────────────────────────

    private async initializeConnection(): Promise<void> {
        try {
        this._post({ type: 'status', state: 'connecting' });

            const isValid = await AdoService.validateConnection(this.context);
            this._connected = isValid;

            if (isValid) {
                await this._handleFetchProjects();
                await this._handleFetchTickets();
            }

            this._post({ type: 'status', state: this._connected ? 'connected' : 'disconnected' });
        } catch (error) {
            this._connected = false;
            console.error('DevFlow auto reconnect failed:', error);
        }
    }

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._buildHtml();

        this.initializeConnection();

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'connect':
                    await this._handleConnect();
                    break;
                case 'fetchTickets':
                    await this._handleFetchTickets();
                    break;
                case 'fetchProjects':
                    await this._handleFetchProjects();
                    break;
                case 'selectProject':
                    await this._handleSelectProject(msg.project);
                    break;
                case 'openTicket':
                    this._handleOpenTicket(msg.id);
                    break;
                case 'runCodeReview':
                  await this._handleRunCodeReview();
                  break;
            }
        });
    }


    // ── Connect ────────────────────────────────────────────────────────────────

    private async _handleConnect() {
        const orgUrl = await vscode.window.showInputBox({
            title: 'Azure DevOps — Step 1/2',
            prompt: 'Organization URL',
            placeHolder: 'https://dev.azure.com/your-org',
            ignoreFocusOut: true
        });
        if (!orgUrl) { return; }

        const pat = await vscode.window.showInputBox({
            title: 'Azure DevOps — Step 2/2',
            prompt: 'Personal Access Token (PAT)',
            password: true,
            ignoreFocusOut: true
        });
        if (!pat) { return; }

        // Show connecting state
        this._post({ type: 'status', state: 'connecting' });

        await AdoService.saveCredentials(this.context, pat, orgUrl);
        const ok = await AdoService.validateConnection(this.context);

        if (ok) {
            this._connected = true;
            this._post({ type: 'status', state: 'connected' });
            await this._handleFetchProjects();
            await this._handleFetchTickets();
        } else {
            // Clear bad credentials
            await AdoService.clearCredentials(this.context);
            this._post({ type: 'status', state: 'disconnected' });
            vscode.window.showErrorMessage('DevFlow: Connection failed — check your org URL and PAT.');
        }
    }

    // ── Projects ───────────────────────────────────────────────────────────────

    private async _handleFetchProjects() {
        try {
            const projects = await AdoService.getProjects(this.context);
            let currentProject = await AdoService.getProject(this.context);
            if ((!currentProject || !projects.includes(currentProject)) && projects.length > 0) {
                currentProject = projects[0];
                await AdoService.setProject(this.context, currentProject);
            }
            this._post({ type: 'projectsLoaded', projects, selected: currentProject });
        } catch (err: any) {
            this._post({ type: 'projectsError', message: err.message });
        }
    }

    private async _handleSelectProject(project: string) {
        await AdoService.setProject(this.context, project);
        await this._handleFetchTickets();
    }

    // ── Fetch Tickets ──────────────────────────────────────────────────────────

    private async _handleFetchTickets() {
        if (!this._connected) {
            this._post({ type: 'ticketsError', message: 'Not connected. Please connect first.' });
            return;
        }

        this._post({ type: 'ticketsLoading' });

        try {
            const tickets = await TicketService.getInstance().fetchAssignedTickets(this.context);
            this._post({ type: 'ticketsLoaded', tickets });
        } catch (err: any) {
            this._post({ type: 'ticketsError', message: err.message });
            vscode.window.showErrorMessage(`DevFlow: ${err.message}`);
        }
    }

    private _handleOpenTicket(id: number) {
        const ticket = TicketService.getInstance().getTicketById(id);
        if (ticket) {
            vscode.commands.executeCommand('devflow.openTicketDetails', ticket);
        } else {
            vscode.window.showErrorMessage(`DevFlow: Ticket #${id} not found.`);
        }
    }

    private async _handleRunCodeReview() {
      this._post({ type: 'codeReviewLoading', stage: 'Starting Code Review...' });
      try {
        const report = await CodeReviewService.runWorkspaceReview((stage) => {
          this._post({ type: 'codeReviewLoading', stage });
        });
        this._post({ type: 'codeReviewLoaded', report });
      } catch (error: any) {
        const message = error instanceof Error ? error.message : String(error);
        this._post({ type: 'codeReviewError', message });
      }
    }

    private _post(msg: object) {
        this._view?.webview.postMessage(msg);
    }

    // ── HTML ───────────────────────────────────────────────────────────────────

    private _buildHtml(): string {
        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';"/>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: 13px;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  }

  /* ── Header ── */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .brand { font-weight: 700; font-size: 13px; letter-spacing: 0.3px; }
  .conn-pill {
    display: flex; align-items: center; gap: 5px;
    font-size: 11px; color: var(--vscode-descriptionForeground);
  }
  .dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--vscode-charts-orange);
    transition: background 0.3s;
  }
  .dot.connected  { background: var(--vscode-charts-green, #4ec9b0); }
  .dot.connecting { background: var(--vscode-charts-yellow, #dcdcaa); }

  .btn-connect {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; border-radius: 3px;
    padding: 3px 10px; font-size: 11px; cursor: pointer;
  }
  .btn-connect:hover { background: var(--vscode-button-hoverBackground); }
  .btn-connect:disabled { opacity: 0.5; cursor: default; }

  #projectSelect {
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 3px;
    font-size: 11px;
    padding: 2px 4px;
    max-width: 110px;
  }

  /* ── Nav rows ── */
  .nav-item {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px 10px 10px;
    border-left: 3px solid transparent;
    border-bottom: 1px solid var(--vscode-panel-border);
    cursor: pointer;
    transition: background 100ms ease;
    user-select: none;
  }
  .nav-item:hover { background: var(--vscode-list-hoverBackground); }
  .nav-item:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }

  .nav-item.tickets  { border-left-color: var(--vscode-charts-blue); }
  .nav-item.review   { border-left-color: var(--vscode-charts-purple); }

  .nav-label { flex: 1; }
  .nav-title { font-size: 13px; font-weight: 600; }
  .nav-sub   { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .chev      { opacity: 0.55; font-size: 14px; }

  .badge {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-size: 11px; font-weight: 700;
    padding: 1px 6px; border-radius: 10px;
    min-width: 20px; text-align: center;
  }
  .badge.hidden { display: none; }

  /* ── Ticket list ── */
  #ticketList { display: none; }

  .ticket-item {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 8px 12px 8px 16px;
    border-bottom: 1px solid var(--vscode-panel-border);
    cursor: pointer;
    transition: background 100ms ease;
  }
  .ticket-item:hover { background: var(--vscode-list-hoverBackground); }
  .ticket-info { flex: 1; min-width: 0; }
  .ticket-title {
    font-size: 12px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .ticket-meta { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }

  .state-badge {
    font-size: 10px; padding: 1px 6px; border-radius: 10px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    white-space: nowrap; flex-shrink: 0;
  }

  /* ── Status messages ── */
  .info-msg {
    padding: 10px 14px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }

  .review-report { display: none; padding: 12px; border-bottom: 1px solid var(--vscode-panel-border); }
  .review-status { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 10px; }
  .review-section { margin-top: 10px; }
  .review-section h3 { font-size: 12px; margin-bottom: 4px; }
  .review-section pre { white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-font-family); font-size: 11px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <span class="brand">DevFlow</span>
  <div class="conn-pill">
    <span class="dot" id="statusDot"></span>
    <span id="statusText">Not connected</span>
  </div>
  <select id="projectSelect" style="display:none;"></select>
  <button class="btn-connect" id="btnConnect">Connect</button>
</div>

<!-- Nav items -->
<div class="nav-item tickets" id="navTickets" role="button" tabindex="0">
  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 6h12M4 10h12M4 14h8"/></svg>
  <div class="nav-label">
    <div class="nav-title">Tickets</div>
    <div class="nav-sub">Assigned to you</div>
  </div>
  <span class="badge hidden" id="ticketBadge">0</span>
  <span class="chev">›</span>
</div>

<div id="ticketList"></div>

<div class="nav-item review" id="navCodeReview" role="button" tabindex="0">
  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5 3 10l4 5"/><path d="M13 5l4 5-4 5"/></svg>
  <div class="nav-label"><div class="nav-title">Code Review</div><div class="nav-sub">Security, dependencies, and quality</div></div>
  <span class="chev">›</span>
</div>

<div class="review-report" id="reviewReport">
  <div class="review-status" id="reviewStatus"></div>
  <div id="reviewSections"></div>
</div>

<script>
  const vscode = acquireVsCodeApi();

  const dot        = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const btnConnect = document.getElementById('btnConnect');
  const navTickets = document.getElementById('navTickets');
  const ticketList = document.getElementById('ticketList');
  const ticketBadge = document.getElementById('ticketBadge');
  const projectSelect = document.getElementById('projectSelect');
  const navCodeReview = document.getElementById('navCodeReview');
  const reviewReport = document.getElementById('reviewReport');
  const reviewStatus = document.getElementById('reviewStatus');
  const reviewSections = document.getElementById('reviewSections');

  // ── UI helpers ──────────────────────────────────────────────────────────────

  function setStatus(state) {
    dot.className = 'dot ' + state;
    if (state === 'connected') {
      statusText.textContent = 'Connected';
      btnConnect.style.display = 'none';
    } else if (state === 'connecting') {
      statusText.textContent = 'Connecting…';
      btnConnect.disabled = true;
    } else {
      statusText.textContent = 'Not connected';
      btnConnect.style.display = '';
      btnConnect.disabled = false;
    }
  }

  function renderTickets(tickets) {
    ticketBadge.textContent = tickets.length;
    ticketBadge.classList.toggle('hidden', tickets.length === 0);

    if (tickets.length === 0) {
      ticketList.innerHTML = '<div class="info-msg">No tickets assigned to you.</div>';
    } else {
      ticketList.innerHTML = tickets.map(t => \`
        <div class="ticket-item" data-id="\${t.id}" role="button" tabindex="0" onclick="openTicket(\${t.id})">
          <div class="ticket-info">
            <div class="ticket-title">#\${t.id} \${escHtml(t.title)}</div>
            <div class="ticket-meta">\${escHtml(t.createdDate ? new Date(t.createdDate).toLocaleDateString() : '')}</div>
          </div>
          <span class="state-badge">\${escHtml(t.state)}</span>
        </div>
      \`).join('');
    }

    ticketList.style.display = 'block';
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function openTicket(id) {
    vscode.postMessage({ type: 'openTicket', id });
  }

  // ── Event listeners ─────────────────────────────────────────────────────────

  btnConnect.addEventListener('click', () => {
    vscode.postMessage({ type: 'connect' });
  });

  projectSelect.addEventListener('change', () => {
    vscode.postMessage({ type: 'selectProject', project: projectSelect.value });
  });

  let ticketOpen = false;
  navTickets.addEventListener('click', () => {
    ticketOpen = !ticketOpen;
    if (ticketOpen) {
      ticketList.innerHTML = '<div class="info-msg">Loading…</div>';
      ticketList.style.display = 'block';
      vscode.postMessage({ type: 'fetchTickets' });
    } else {
      ticketList.style.display = 'none';
    }
  });

  navTickets.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') navTickets.click();
  });

  navCodeReview.addEventListener('click', () => {
    reviewReport.style.display = 'block';
    reviewSections.innerHTML = '';
    reviewStatus.textContent = 'Starting Code Review...';
    navCodeReview.setAttribute('aria-busy', 'true');
    vscode.postMessage({ type: 'runCodeReview' });
  });

  navCodeReview.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') navCodeReview.click();
  });

  // ── Messages from extension ─────────────────────────────────────────────────

  window.addEventListener('message', ({ data: msg }) => {
    switch (msg.type) {
      case 'status':
        setStatus(msg.state);
        break;
      case 'ticketsLoading':
        ticketList.innerHTML = '<div class="info-msg">Loading…</div>';
        ticketList.style.display = 'block';
        break;
      case 'ticketsLoaded':
        renderTickets(msg.tickets);
        break;
      case 'projectsLoaded':
        projectSelect.innerHTML = msg.projects.map(p => \`<option value="\${escHtml(p)}"\${msg.selected === p ? ' selected' : ''}>\${escHtml(p)}</option>\`).join('');
        projectSelect.style.display = msg.projects.length > 0 ? '' : 'none';
        break;
      case 'ticketsError':
        ticketList.innerHTML = \`<div class="info-msg" style="color:var(--vscode-errorForeground)">\${escHtml(msg.message)}</div>\`;
        ticketList.style.display = 'block';
        break;
      case 'codeReviewLoading':
        reviewReport.style.display = 'block';
        reviewStatus.textContent = msg.stage;
        break;
      case 'codeReviewLoaded':
        navCodeReview.setAttribute('aria-busy', 'false');
        reviewStatus.textContent = msg.report.errors.length
          ? 'Completed with some analysis errors.'
          : 'Completed';
        reviewSections.innerHTML = Object.entries(msg.report.sections).map(([title, content]) =>
          \`<section class="review-section"><h3>\${escHtml(title)}</h3><pre>\${escHtml(content)}</pre></section>\`
        ).join('') + (msg.report.errors.length
          ? \`<section class="review-section"><h3>Analysis Errors</h3><pre>\${escHtml(msg.report.errors.join('\\n'))}</pre></section>\`
          : '');
        break;
      case 'codeReviewError':
        navCodeReview.setAttribute('aria-busy', 'false');
        reviewStatus.textContent = 'Code Review failed';
        reviewStatus.style.color = 'var(--vscode-errorForeground)';
        reviewSections.innerHTML = \`<div class="info-msg">\${escHtml(msg.message)}</div>\`;
        break;
    }
  });
</script>
</body>
</html>`;
    }
}
