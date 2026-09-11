import * as vscode from 'vscode';

export interface SymbolMatch {
    name: string;
    kind: string;
    filePath: string;
    line: number;
}

export class SymbolSearchService {
    public static async searchSymbols(keywords: string[]): Promise<SymbolMatch[]> {
        const matches: SymbolMatch[] = [];

        for (const keyword of keywords) {
            const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                'vscode.executeWorkspaceSymbolProvider',
                keyword
            );

            for (const symbol of symbols ?? []) {
                matches.push({
                    name: symbol.name,
                    kind: this.symbolKindToString(symbol.kind),
                    filePath: symbol.location.uri.fsPath,
                    line: symbol.location.range.start.line + 1
                });
            }
        }

        const uniqueMatches = new Map<string, SymbolMatch>();
        for (const match of matches) {
            const key = `${match.filePath}:${match.line}:${match.name}:${match.kind}`;
            uniqueMatches.set(key, match);
        }

        return [...uniqueMatches.values()];
    }

    private static symbolKindToString(kind: vscode.SymbolKind): string {
        return vscode.SymbolKind[kind] ?? String(kind);
    }
}
