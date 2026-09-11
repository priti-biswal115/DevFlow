import * as vscode from 'vscode';

export interface RelevantMethod {
    name: string;
    kind: string;
    line: number;
    file: string;
    score: number;
}

export class MethodDiscoveryService {
    public static async findRelevantMethods(
        filePaths: string[],
        keywords: string[]
    ): Promise<RelevantMethod[]> {
        const methods: RelevantMethod[] = [];

        for (const filePath of filePaths) {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                document.uri
            );

            this.collectSymbols(symbols ?? [], filePath, keywords, methods, '');
        }

        return methods.sort((a, b) => b.score - a.score);
    }

    private static collectSymbols(
        symbols: vscode.DocumentSymbol[],
        filePath: string,
        keywords: string[],
        output: RelevantMethod[],
        parentName: string
    ): void {
        for (const symbol of symbols) {
            const kind = vscode.SymbolKind[symbol.kind] ?? String(symbol.kind);
            const normalizedKind = kind.toLowerCase();
            const isRelevant = ['class', 'method', 'function', 'interface'].includes(normalizedKind);

            if (isRelevant) {
                output.push({
                    name: symbol.name,
                    kind,
                    line: symbol.range.start.line + 1,
                    file: filePath,
                    score: this.scoreSymbol(`${parentName} ${symbol.name}`, kind, keywords)
                });
            }

            if (symbol.children?.length) {
                this.collectSymbols(symbol.children, filePath, keywords, output, symbol.name);
            }
        }
    }

    private static scoreSymbol(name: string, kind: string, keywords: string[]): number {
        const text = name.toLowerCase();
        let score = 0;

        for (const keyword of keywords) {
            if (text.includes(keyword.toLowerCase())) {
                score += 10;
            }
        }

        if (kind.toLowerCase() === 'class') {
            score += 3;
        }

        return score;
    }
}
