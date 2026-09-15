import * as vscode from 'vscode';

export interface SymbolMatch {
    file: string;
    symbol: string;
    kind: string;
    line: number;
    score: number;
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
                const kind = this.symbolKindToString(symbol.kind);
                if (!this.isNamedSymbol(symbol.name) || !this.isSupportedKind(kind)) {
                    continue;
                }

                matches.push({
                    file: symbol.location.uri.fsPath,
                    symbol: symbol.name,
                    kind,
                    line: symbol.location.range.start.line + 1,
                    score: this.scoreSymbol(symbol.kind)
                });
            }
        }

        const uniqueMatches = new Map<string, SymbolMatch>();
        for (const match of matches) {
            const key = `${match.file}:${match.line}:${match.symbol}:${match.kind}`;
            uniqueMatches.set(key, match);
        }

        return [...uniqueMatches.values()];
    }

    private static symbolKindToString(kind: vscode.SymbolKind): string {
        return vscode.SymbolKind[kind] ?? String(kind);
    }

    private static isNamedSymbol(name: string): boolean {
        return Boolean(name.trim()) && !/^<.*>$/.test(name.trim());
    }

    private static isSupportedKind(kind: string): boolean {
        return ['Class', 'Function', 'Method', 'Interface'].includes(kind);
    }

    private static scoreSymbol(kind: vscode.SymbolKind): number {
        switch (kind) {
            case vscode.SymbolKind.Method:
                return 10;
            case vscode.SymbolKind.Class:
            case vscode.SymbolKind.Function:
                return 8;
            case vscode.SymbolKind.Interface:
                return 6;
            default:
                return 2;
        }
    }
}
