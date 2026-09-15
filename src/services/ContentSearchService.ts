import * as vscode from 'vscode';

export interface ContentMatch {
    filePath: string;
    line: number;
    term: string;
    score: number;
    reason: string;
}

export class ContentSearchService {
    private static readonly excludePattern = '**/{node_modules,.git,dist,build,coverage,out}/**';

    public static async searchContent(searchTerms: string[]): Promise<ContentMatch[]> {
        const matches: ContentMatch[] = [];
        const workspace = vscode.workspace as typeof vscode.workspace & {
            findTextInFiles?: (
                query: { pattern: string; isRegExp?: boolean; isCaseSensitive?: boolean; isWordMatch?: boolean },
                options: { exclude?: string; maxResults?: number },
                callback: (result: any) => void
            ) => Thenable<unknown>;
        };

        if (!workspace.findTextInFiles) {
            return [];
        }

        for (const term of searchTerms.filter(Boolean)) {
            await workspace.findTextInFiles(
                { pattern: term, isRegExp: false, isCaseSensitive: false, isWordMatch: false },
                { exclude: this.excludePattern, maxResults: 200 },
                (result: any) => {
                    const line = result.ranges[0]?.start.line ?? 0;
                    matches.push({
                        filePath: result.uri.fsPath,
                        line: line + 1,
                        term,
                        score: this.scoreTerm(term, result.preview.text),
                        reason: this.reasonFor(term, result.uri)
                    });
                }
            );
        }

        return matches;
    }

    private static scoreTerm(term: string, preview: string): number {
        const lowerTerm = term.toLowerCase();
        const lowerPreview = preview.toLowerCase();

        if (lowerTerm.includes('document.title') || lowerPreview.includes('document.title')) {
            return 18;
        }
        if (lowerTerm.includes('<title') || /<title\b/i.test(preview)) {
            return 20;
        }
        if (lowerTerm === 'title' && /<title\b|document\.title/i.test(preview)) {
            return 16;
        }

        return 6;
    }

    private static reasonFor(term: string, uri: vscode.Uri): string {
        const relativePath = vscode.workspace.asRelativePath(uri);
        if (term.toLowerCase().includes('title')) {
            return `Found title-related content in ${relativePath}.`;
        }
        return `Found "${term}" in ${relativePath}.`;
    }
}
