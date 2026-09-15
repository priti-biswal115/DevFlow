import * as vscode from 'vscode';
import { Ticket } from '../types/ticket';
import { ContentMatch, ContentSearchService } from './ContentSearchService';
import { MethodDiscoveryService, RelevantMethod } from './MethodDiscoveryService';
import { SymbolMatch, SymbolSearchService } from './SymbolSearchService';
import { TicketUnderstanding, TicketUnderstandingService } from './TicketUnderstandingService';

export interface DiscoveredFile {
    path: string;
    relativePath: string;
    score: number;
    matchedSymbols: Array<Pick<SymbolMatch, 'symbol' | 'kind' | 'line'>>;
    relevantMethods: RelevantMethod[];
    reasoning: string[];
}

export interface DiscoveryResult {
    files: DiscoveredFile[];
    symbols: SymbolMatch[];
    methods: RelevantMethod[];
    reasoning: string[];
}

type CandidateFile = DiscoveredFile & {
    pathScore: number;
    contentScore: number;
    symbolScore: number;
    rawScore: number;
};

export class FileDiscoveryService {
    public static async findRelevantFiles(ticket: Ticket): Promise<DiscoveryResult> {
        const understanding = TicketUnderstandingService.understand(ticket.title, ticket.description);
        const searchTerms = understanding.searchTerms;
        if (searchTerms.length === 0) {
            return { files: [], symbols: [], methods: [], reasoning: ['No useful search terms were extracted from the ticket.'] };
        }

        const excludePattern = '**/{node_modules,.git,dist,build,coverage,out}/**';
        const workspaceFiles = await vscode.workspace.findFiles('**/*', excludePattern, 1500);
        const candidates = new Map<string, CandidateFile>();

        for (const uri of workspaceFiles) {
            const relativePath = vscode.workspace.asRelativePath(uri);
            const pathScore = this.calculatePathScore(relativePath, searchTerms, understanding);
            if (pathScore > 0 || this.isLikelyFile(relativePath, understanding)) {
                const file = this.ensureCandidate(candidates, uri.fsPath, relativePath);
                file.pathScore += pathScore;
                if (pathScore > 0) {
                    file.reasoning.push('Filename or path matched ticket search terms.');
                }
                if (this.isLikelyFile(relativePath, understanding)) {
                    file.reasoning.push(`Matched ${understanding.intent} likely-file pattern.`);
                }
            }
        }

        const [contentMatches, symbols] = await Promise.all([
            ContentSearchService.searchContent(searchTerms),
            SymbolSearchService.searchSymbols([...new Set([...searchTerms, ...understanding.likelySymbols])])
        ]);

        for (const match of contentMatches) {
            const relativePath = vscode.workspace.asRelativePath(match.filePath);
            const file = this.ensureCandidate(candidates, match.filePath, relativePath);
            file.contentScore += match.score;
            file.reasoning.push(match.reason);
        }

        for (const symbol of symbols) {
            const relativePath = vscode.workspace.asRelativePath(symbol.file);
            const file = this.ensureCandidate(candidates, symbol.file, relativePath);
            file.symbolScore += symbol.score;
            file.matchedSymbols.push({
                symbol: symbol.symbol,
                kind: symbol.kind,
                line: symbol.line
            });
            file.reasoning.push(`Matched ${symbol.kind.toLowerCase()} ${symbol.symbol}.`);
        }

        const rankedFiles = [...candidates.values()]
            .map((file) => {
                const boostedScore = this.hybridScore(file) + this.intentBoost(file.relativePath, understanding);
                return { ...file, rawScore: boostedScore };
            })
            .filter((file) => file.rawScore > 0)
            .sort((a, b) => b.rawScore - a.rawScore);

        const topFiles = rankedFiles.slice(0, 10);
        const methods = await MethodDiscoveryService.findRelevantMethods(
            topFiles.map((file) => file.path),
            searchTerms
        );

        for (const file of topFiles) {
            file.relevantMethods = methods.filter((method) => method.file === file.path).slice(0, 5);
        }

        const maxScore = topFiles[0]?.rawScore ?? 1;
        const files = topFiles.map(({ pathScore, contentScore, symbolScore, rawScore, ...file }) => ({
            ...file,
            score: maxScore > 0 ? (rawScore / maxScore) * 0.99 : 0
        }));

        return {
            files,
            symbols,
            methods,
            reasoning: this.buildReasoning(understanding, files, contentMatches)
        };
    }

    private static ensureCandidate(
        candidates: Map<string, CandidateFile>,
        path: string,
        relativePath: string
    ): CandidateFile {
        const existing = candidates.get(path);
        if (existing) {
            return existing;
        }

        const file: CandidateFile = {
            path,
            relativePath,
            score: 0,
            pathScore: 0,
            contentScore: 0,
            symbolScore: 0,
            rawScore: 0,
            matchedSymbols: [],
            relevantMethods: [],
            reasoning: []
        };
        candidates.set(path, file);
        return file;
    }

    private static calculatePathScore(
        relativePath: string,
        searchTerms: string[],
        understanding: TicketUnderstanding
    ): number {
        const lowerPath = relativePath.toLowerCase();
        const fileName = lowerPath.split(/[\\/]/).pop() || '';
        let score = 0;

        for (const term of searchTerms.map((value) => value.toLowerCase())) {
            if (fileName.includes(term)) {
                score += 5;
            } else if (lowerPath.includes(term)) {
                score += 1;
            }
        }

        if (this.isLikelyFile(relativePath, understanding)) {
            score += 8;
        }

        return score;
    }

    private static hybridScore(file: CandidateFile): number {
        return 0.3 * file.pathScore + 0.4 * file.contentScore + 0.3 * file.symbolScore;
    }

    private static intentBoost(relativePath: string, understanding: TicketUnderstanding): number {
        if (understanding.intent !== 'UI Metadata Change') {
            return 0;
        }

        const fileName = relativePath.toLowerCase().split(/[\\/]/).pop() || '';
        if (['index.html', 'app.tsx', 'app.jsx', 'main.tsx', 'main.jsx'].includes(fileName)) {
            return fileName === 'index.html' ? 30 : 12;
        }

        return 0;
    }

    private static isLikelyFile(relativePath: string, understanding: TicketUnderstanding): boolean {
        const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
        return understanding.likelyFiles.some((likelyFile) => normalized.endsWith(likelyFile.toLowerCase()));
    }

    private static buildReasoning(
        understanding: TicketUnderstanding,
        files: DiscoveredFile[],
        contentMatches: ContentMatch[]
    ): string[] {
        const reasoning = [`Ticket intent: ${understanding.intent}.`];
        if (understanding.intent === 'UI Metadata Change') {
            reasoning.push('Ticket appears related to website title metadata.');
        }

        for (const file of files.slice(0, 5)) {
            const matches = contentMatches.filter((match) => match.filePath === file.path);
            if (matches.length > 0) {
                reasoning.push(matches[0].reason);
            } else if (this.isLikelyFile(file.relativePath, understanding)) {
                reasoning.push(`${file.relativePath} is a likely file for ${understanding.intent}.`);
            }
        }

        return [...new Set(reasoning)];
    }
}
