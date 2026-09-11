import * as vscode from 'vscode';
import { Ticket } from '../types/ticket';
import { MethodDiscoveryService, RelevantMethod } from './MethodDiscoveryService';
import { SymbolMatch, SymbolSearchService } from './SymbolSearchService';

export interface DiscoveredFile {
    path: string;
    relativePath: string;
    score: number;
    matchedSymbols: Array<Pick<SymbolMatch, 'name' | 'kind' | 'line'>>;
    relevantMethods: RelevantMethod[];
}

export class FileDiscoveryService {
    public static async findRelevantFiles(ticket: Ticket): Promise<DiscoveredFile[]> {
        // 1. Extract Keywords
        const keywords = this.extractKeywords(ticket.title, ticket.description);
        if (keywords.length === 0) {
            return [];
        }

        // 2. Search Workspace
        // Find all files excluding the standard ignores
        const excludePattern = '**/{node_modules,.git,dist,build,coverage,out}/**';
        const files = await vscode.workspace.findFiles('**/*', excludePattern, 1000); // Limit to 1000 files to avoid performance issues

        const symbols = await SymbolSearchService.searchSymbols(keywords);

        // 3. Rank Matching Files
        const rankedFiles = (await Promise.all(files.map(async uri => {
            const relativePath = vscode.workspace.asRelativePath(uri);
            const score = this.calculateMatchScore(relativePath, keywords);
            const content = await this.readTextContent(uri);
            return {
                path: uri.fsPath,
                relativePath,
                score: score + this.calculateContentScore(content, keywords),
                matchedSymbols: [] as DiscoveredFile['matchedSymbols'],
                relevantMethods: [] as RelevantMethod[]
            };
        }))).filter((file) => file.score > 0);

        const filesByPath = new Map(rankedFiles.map(file => [file.path, file]));
        for (const symbol of symbols) {
            const file = filesByPath.get(symbol.filePath);
            if (!file) {
                continue;
            }

            file.score += this.symbolMatchScore(symbol.kind);
            file.matchedSymbols.push({
                name: symbol.name,
                kind: symbol.kind,
                line: symbol.line
            });
        }

        const relevantFiles = rankedFiles.filter(f => f.score > 0);

        // Sort descending by score
        relevantFiles.sort((a, b) => b.score - a.score);

        // Normalize scores to be percentages of the max score if we want, or just max out at 1
        // Here we'll just cap it at 1 for percentage display (e.g. 0.87 = 87%)
        const maxScore = relevantFiles.length > 0 ? relevantFiles[0].score : 1;
        const topFiles = relevantFiles.slice(0, 10);
        const methods = await MethodDiscoveryService.findRelevantMethods(
            topFiles.map((file) => file.path),
            keywords
        );
        const filesWithMethods = topFiles.map((file) => {
            file.relevantMethods = methods.filter((method) => method.file === file.path);
            return file;
        });

        const normalizedFiles = filesWithMethods.map(f => ({
            ...f,
            score: maxScore > 0 ? (f.score / maxScore) * 0.99 : 0 // max 99% for realism, adjust as needed
        }));

        // 4. Display Top 10
        return normalizedFiles;
    }

    private static extractKeywords(title: string, description: string): string[] {
        // Simple extraction: combine text, lower case, remove html tags, remove non-alphanumeric, split
        const htmlStrippedDesc = (description || '').replace(/<[^>]*>?/gm, ' ');
        const combined = `${title || ''} ${htmlStrippedDesc}`.toLowerCase();
        
        const words = combined.match(/\b[a-z]{3,}\b/g) || [];
        
        // Basic stop words to ignore
        const stopWords = new Set([
            'the', 'and', 'for', 'with', 'this', 'that', 'you', 'not', 'are', 'from',
            'have', 'but', 'all', 'what', 'can', 'will', 'any', 'which', 'there',
            'has', 'was', 'were', 'they', 'their', 'when', 'how', 'about', 'out',
            'like', 'one', 'then', 'so', 'some', 'them', 'would', 'could', 'should',
            'our', 'these', 'those', 'also', 'just', 'only', 'very', 'even', 'into',
            'because', 'than', 'upon', 'been', 'much', 'more', 'most', 'other', 'another',
            'such', 'through', 'while', 'where', 'after', 'before', 'since', 'until',
            'although', 'though', 'whether', 'both', 'each', 'every', 'either', 'neither',
            'many', 'few', 'several', 'less', 'least', 'well', 'good', 'better', 'best',
            'bad', 'worse', 'worst', 'right', 'wrong', 'true', 'false', 'yes', 'no',
            'div', 'span', 'class', 'style', 'html', 'body', 'head', 'title', 'meta'
        ]);

        const keywords = words.filter(w => !stopWords.has(w));
        
        // Return unique keywords
        return [...new Set(keywords)];
    }

    private static calculateMatchScore(filePath: string, keywords: string[]): number {
        // Very basic ranking: check how many keywords appear in the file path
        let score = 0;
        const lowerPath = filePath.toLowerCase();
        
        // Give higher weight to matches in the file name itself vs directory path
        const fileName = lowerPath.split('/').pop() || '';

        for (const kw of keywords) {
            if (fileName.includes(kw)) {
                score += 5; // Strong match in filename
            } else if (lowerPath.includes(kw)) {
                score += 1; // Weak match in path
            }
        }
        
        return score;
    }

    private static calculateContentScore(content: string, keywords: string[]): number {
        const lowerContent = content.toLowerCase();
        return keywords.reduce((score, keyword) => {
            const matches = lowerContent.match(new RegExp(this.escapeRegExp(keyword), 'g'));
            return score + (matches?.length ?? 0) * 3;
        }, 0);
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

    private static escapeRegExp(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private static symbolMatchScore(kind: string): number {
        switch (kind.toLowerCase()) {
            case 'class':
                return 8;
            case 'method':
                return 10;
            case 'interface':
                return 6;
            case 'function':
                return 8;
            default:
                return 0;
        }
    }
}
