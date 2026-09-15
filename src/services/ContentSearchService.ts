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
        return this.searchContentByReadingFiles(searchTerms);
    }

    private static async searchContentByReadingFiles(searchTerms: string[]): Promise<ContentMatch[]> {
        const matches: ContentMatch[] = [];
        const files = await vscode.workspace.findFiles('**/*', this.excludePattern, 1500);

        for (const uri of files) {
            const content = await this.readTextContent(uri);
            if (!content) {
                continue;
            }

            const lowerContent = content.toLowerCase();
            const lines = content.split(/\r?\n/);
            for (const term of searchTerms.filter(Boolean)) {
                const lowerTerm = term.toLowerCase();
                if (!lowerContent.includes(lowerTerm)) {
                    continue;
                }

                const lineIndex = lines.findIndex((line) => line.toLowerCase().includes(lowerTerm));
                matches.push({
                    filePath: uri.fsPath,
                    line: lineIndex >= 0 ? lineIndex + 1 : 1,
                    term,
                    score: this.scoreTerm(term, lines[lineIndex] ?? content.slice(0, 200)),
                    reason: this.reasonFor(term, uri)
                });
            }
        }

        return matches;
    }

    private static async readTextContent(uri: vscode.Uri): Promise<string> {
        const binaryExtensions = new Set([
            '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip',
            '.exe', '.dll', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4'
        ]);
        const extension = uri.fsPath.toLowerCase().slice(uri.fsPath.lastIndexOf('.'));
        if (binaryExtensions.has(extension)) {
            return '';
        }

        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const content = Buffer.from(bytes).toString('utf8');
            return content.includes('\0') ? '' : content;
        } catch {
            return '';
        }
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
