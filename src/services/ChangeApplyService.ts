import * as vscode from 'vscode';

export interface ProposedEdit {
    relativePath: string;
    uri: vscode.Uri;
    newContent: string;
    /** undefined when the file does not exist yet */
    originalContent?: string;
}

/** Virtual read-only documents holding the agent's proposed file contents, used by the diff view. */
export const PROPOSED_SCHEME = 'devflow-proposed';

class ProposedContentProvider implements vscode.TextDocumentContentProvider {
    private readonly _contents = new Map<string, string>();
    private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    public readonly onDidChange = this._onDidChange.event;

    public set(uri: vscode.Uri, content: string) {
        this._contents.set(uri.toString(), content);
        this._onDidChange.fire(uri);
    }

    public provideTextDocumentContent(uri: vscode.Uri): string {
        return this._contents.get(uri.toString()) ?? '';
    }
}

const addedLineDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    overviewRulerColor: new vscode.ThemeColor('diffEditorOverview.insertedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left
});

export class ChangeApplyService {
    private static _provider: ProposedContentProvider | undefined;
    private static _lastApplied: ProposedEdit[] = [];
    private static _decoratedUris = new Set<string>();

    public static register(context: vscode.ExtensionContext) {
        this._provider = new ProposedContentProvider();
        context.subscriptions.push(
            vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, this._provider)
        );
    }

    /**
     * Extracts file edits from the agent's markdown response.
     * Recognised forms:
     *   ### FILE: src/a.ts        (followed by a fenced block)
     *   **File: src/a.ts**        (followed by a fenced block)
     *   ```ts path=src/a.ts
     *   ```ts                     (with `// filepath: src/a.ts` as the first line)
     */
    public static async parseEdits(markdown: string): Promise<ProposedEdit[]> {
        const root = vscode.workspace.workspaceFolders?.[0];
        if (!root) {
            return [];
        }

        const lines = markdown.split(/\r?\n/);
        const results: { relativePath: string; content: string }[] = [];
        let pendingPath: string | undefined;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            const headerMatch =
                /^\s*#{1,6}\s*(?:FILE|File)\s*:\s*(.+?)\s*$/.exec(line) ??
                /^\s*\*\*\s*(?:FILE|File)\s*:\s*(.+?)\s*\*\*\s*$/.exec(line);
            if (headerMatch) {
                pendingPath = this._cleanPath(headerMatch[1]);
                continue;
            }

            const fenceMatch = /^(\s*)```+\s*(.*)$/.exec(line);
            if (!fenceMatch) {
                continue;
            }

            const indent = fenceMatch[1];
            const info = fenceMatch[2];

            const body: string[] = [];
            let j = i + 1;
            for (; j < lines.length; j++) {
                if (/^\s*```+\s*$/.test(lines[j])) {
                    break;
                }
                body.push(lines[j].startsWith(indent) ? lines[j].slice(indent.length) : lines[j]);
            }
            i = j;

            let filePath =
                pendingPath ??
                this._cleanPath(/(?:path|file|filepath)\s*=\s*["']?([^"'\s]+)/i.exec(info)?.[1] ?? '');
            pendingPath = undefined;

            const firstLinePath = /^\s*(?:\/\/|#|--|\/\*|<!--)\s*filepath\s*:\s*(.+?)\s*(?:\*\/|-->)?\s*$/i.exec(
                body[0] ?? ''
            );
            if (firstLinePath) {
                filePath = filePath || this._cleanPath(firstLinePath[1]);
                body.shift();
            }

            if (!filePath) {
                continue;
            }

            results.push({ relativePath: filePath, content: body.join('\n').replace(/\s*$/, '') + '\n' });
        }

        // Later blocks for the same file win.
        const byPath = new Map<string, string>();
        for (const r of results) {
            byPath.set(r.relativePath, r.content);
        }

        const edits: ProposedEdit[] = [];
        for (const [relativePath, newContent] of byPath) {
            const uri = vscode.Uri.joinPath(root.uri, ...relativePath.split(/[\\/]/));
            let originalContent: string | undefined;
            try {
                originalContent = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
            } catch {
                originalContent = undefined;
            }
            edits.push({ relativePath, uri, newContent, originalContent });
        }
        return edits;
    }

    /** Opens a side-by-side diff for every proposed edit. */
    public static async review(edits: ProposedEdit[]) {
        if (!this._provider) {
            throw new Error('DevFlow: change provider not registered.');
        }

        for (const edit of edits) {
            const proposedUri = edit.uri.with({
                scheme: PROPOSED_SCHEME,
                query: `t=${Date.now()}`
            });
            this._provider.set(proposedUri, edit.newContent);

            const left = edit.originalContent === undefined
                ? vscode.Uri.parse(`${PROPOSED_SCHEME}:empty`)
                : edit.uri;
            if (edit.originalContent === undefined) {
                this._provider.set(left, '');
            }

            await vscode.commands.executeCommand(
                'vscode.diff',
                left,
                proposedUri,
                `${edit.relativePath} (Current ↔ DevFlow Proposal)`,
                { preview: false }
            );
        }
    }

    /** Writes the proposed content to the real files and highlights the changed lines in green. */
    public static async apply(edits: ProposedEdit[]) {
        this.clearHighlights();

        const workspaceEdit = new vscode.WorkspaceEdit();
        for (const edit of edits) {
            if (edit.originalContent === undefined) {
                workspaceEdit.createFile(edit.uri, { overwrite: false, ignoreIfExists: true });
                workspaceEdit.insert(edit.uri, new vscode.Position(0, 0), edit.newContent);
            } else {
                const doc = await vscode.workspace.openTextDocument(edit.uri);
                workspaceEdit.replace(
                    edit.uri,
                    new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
                    edit.newContent
                );
            }
        }

        const ok = await vscode.workspace.applyEdit(workspaceEdit);
        if (!ok) {
            throw new Error('VS Code rejected the workspace edit.');
        }

        this._lastApplied = edits;

        for (const edit of edits) {
            const doc = await vscode.workspace.openTextDocument(edit.uri);
            const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
            const changed = this._changedLineRanges(edit.originalContent ?? '', edit.newContent);
            editor.setDecorations(addedLineDecoration, changed);
            this._decoratedUris.add(edit.uri.toString());
            if (changed.length > 0) {
                editor.revealRange(changed[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            }
        }
    }

    /** Restores the pre-apply content of the last applied edit set. */
    public static async undoLast() {
        if (this._lastApplied.length === 0) {
            return;
        }
        const workspaceEdit = new vscode.WorkspaceEdit();
        for (const edit of this._lastApplied) {
            if (edit.originalContent === undefined) {
                workspaceEdit.deleteFile(edit.uri, { ignoreIfNotExists: true });
            } else {
                const doc = await vscode.workspace.openTextDocument(edit.uri);
                workspaceEdit.replace(
                    edit.uri,
                    new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
                    edit.originalContent
                );
            }
        }
        await vscode.workspace.applyEdit(workspaceEdit);
        this._lastApplied = [];
        this.clearHighlights();
    }

    public static clearHighlights() {
        for (const editor of vscode.window.visibleTextEditors) {
            if (this._decoratedUris.has(editor.document.uri.toString())) {
                editor.setDecorations(addedLineDecoration, []);
            }
        }
        this._decoratedUris.clear();
    }

    private static _cleanPath(raw: string): string {
        return raw
            .trim()
            .replace(/^[`*"']+|[`*"':]+$/g, '')
            .replace(/^\.\//, '')
            .trim();
    }

    /** Line indices in `next` that are new or modified relative to `prev`. */
    private static _changedLineRanges(prev: string, next: string): vscode.Range[] {
        const a = prev.split(/\r?\n/);
        const b = next.split(/\r?\n/);

        let changed: number[];
        if (a.length * b.length > 4_000_000) {
            changed = b.map((_, i) => i);
        } else {
            const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
            for (let i = a.length - 1; i >= 0; i--) {
                for (let j = b.length - 1; j >= 0; j--) {
                    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
                }
            }
            changed = [];
            let i = 0;
            let j = 0;
            while (i < a.length && j < b.length) {
                if (a[i] === b[j]) {
                    i++;
                    j++;
                } else if (dp[i + 1][j] >= dp[i][j + 1]) {
                    i++;
                } else {
                    changed.push(j++);
                }
            }
            while (j < b.length) {
                changed.push(j++);
            }
        }

        const ranges: vscode.Range[] = [];
        for (const lineNumber of changed) {
            const last = ranges[ranges.length - 1];
            if (last && last.end.line === lineNumber - 1) {
                ranges[ranges.length - 1] = last.with(undefined, new vscode.Position(lineNumber, 0));
            } else {
                ranges.push(new vscode.Range(lineNumber, 0, lineNumber, 0));
            }
        }
        return ranges;
    }
}
