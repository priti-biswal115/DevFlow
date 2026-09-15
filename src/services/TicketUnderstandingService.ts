export interface TicketUnderstanding {
    intent: string;
    entities: string[];
    technologies: string[];
    searchTerms: string[];
    likelyFiles: string[];
    likelySymbols: string[];
}

export class TicketUnderstandingService {
    public static understand(title: string, description: string): TicketUnderstanding {
        const text = this.stripHtml(`${title || ''} ${description || ''}`);
        const lowerText = text.toLowerCase();
        const entities = this.extractQuotedEntities(text);
        const keywords = this.extractKeywords(text);

        if (this.isWebsiteTitleChange(lowerText)) {
            return {
                intent: 'UI Metadata Change',
                entities,
                technologies: this.detectTechnologies(lowerText),
                searchTerms: [...new Set(['title', 'document.title', '<title', 'head', 'html', ...entities, ...keywords])],
                likelyFiles: ['index.html', 'App.jsx', 'App.tsx', 'main.jsx', 'main.tsx'],
                likelySymbols: ['App', 'title']
            };
        }

        return {
            intent: 'General Code Change',
            entities,
            technologies: this.detectTechnologies(lowerText),
            searchTerms: keywords,
            likelyFiles: [],
            likelySymbols: keywords
        };
    }

    private static isWebsiteTitleChange(text: string): boolean {
        return /\b(change|update|set|rename)\b/.test(text)
            && /\b(website|site|browser|page)?\s*title\b/.test(text);
    }

    private static stripHtml(value: string): string {
        return value.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    }

    private static extractQuotedEntities(text: string): string[] {
        const quoted = [...text.matchAll(/["'“”](.+?)["'“”]/g)].map((match) => match[1].trim());
        const titleTarget = /\b(?:to|as)\s+([A-Z][\w]*(?:\s+[A-Z][\w]*)*)/.exec(text)?.[1];
        return [...new Set([...quoted, ...(titleTarget ? [titleTarget] : [])])];
    }

    private static extractKeywords(text: string): string[] {
        const words = this.stripHtml(text).toLowerCase().match(/\b[a-z][a-z0-9.]{2,}\b/g) || [];
        const stopWords = new Set([
            'the', 'and', 'for', 'with', 'this', 'that', 'you', 'not', 'are', 'from',
            'have', 'but', 'all', 'what', 'can', 'will', 'any', 'which', 'there',
            'has', 'was', 'were', 'they', 'their', 'when', 'how', 'about', 'out',
            'like', 'one', 'then', 'into', 'change', 'update', 'set', 'rename'
        ]);
        return [...new Set(words.filter((word) => !stopWords.has(word)))];
    }

    private static detectTechnologies(text: string): string[] {
        const technologies: string[] = [];
        if (/\breact\b|jsx|tsx/.test(text)) {
            technologies.push('React');
        }
        if (/\bhtml\b|website|browser|page/.test(text)) {
            technologies.push('HTML');
        }
        if (/\btypescript\b|tsx|\.ts\b/.test(text)) {
            technologies.push('TypeScript');
        }
        return technologies;
    }
}
