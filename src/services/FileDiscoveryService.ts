import * as vscode from 'vscode';
import { Ticket } from '../types/ticket';

export class FileDiscoveryService {
    public static async findRelevantFiles(ticket: Ticket): Promise<{ path: string; relativePath: string; score: number }[]> {
        // 1. Extract Keywords
        const keywords = this.extractKeywords(ticket.title, ticket.description);
        if (keywords.length === 0) {
            return [];
        }

        // 2. Search Workspace
        // Find all files excluding the standard ignores
        const excludePattern = '**/{node_modules,.git,dist,build,coverage,out}/**';
        const files = await vscode.workspace.findFiles('**/*', excludePattern, 1000); // Limit to 1000 files to avoid performance issues

        // 3. Rank Matching Files
        const rankedFiles = files.map(uri => {
            const relativePath = vscode.workspace.asRelativePath(uri);
            const score = this.calculateMatchScore(relativePath, keywords);
            return {
                path: uri.fsPath,
                relativePath,
                score
            };
        }).filter(f => f.score > 0); // Only keep files that have some match

        // Sort descending by score
        rankedFiles.sort((a, b) => b.score - a.score);

        // Normalize scores to be percentages of the max score if we want, or just max out at 1
        // Here we'll just cap it at 1 for percentage display (e.g. 0.87 = 87%)
        const maxScore = rankedFiles.length > 0 ? rankedFiles[0].score : 1;
        const normalizedFiles = rankedFiles.map(f => ({
            ...f,
            score: maxScore > 0 ? (f.score / maxScore) * 0.99 : 0 // max 99% for realism, adjust as needed
        }));

        // 4. Display Top 10
        return normalizedFiles.slice(0, 10);
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
}
