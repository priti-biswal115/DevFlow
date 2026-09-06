import * as vscode from 'vscode';

export class CopilotService {
    public static async executeTicket(
        contextPackage: any,
        onChunk: (chunk: string) => void,
        token: vscode.CancellationToken
    ): Promise<string> {
        let model = await this.getModel();
        
        if (!model) {
            throw new Error('No Copilot language model found. Please ensure GitHub Copilot is installed and you are signed in.');
        }

        const messages = this.buildPrompt(contextPackage);

        try {
            const response = await model.sendRequest(messages, {}, token);
            let fullContent = '';
            
            for await (const chunk of response.text) {
                if (token.isCancellationRequested) {
                    break;
                }
                fullContent += chunk;
                onChunk(chunk);
            }
            return fullContent;
        } catch (err: any) {
            if (err instanceof vscode.LanguageModelError) {
                console.error(err.message, err.code, err.cause);
            } else {
                throw err;
            }
            return '';
        }
    }

    private static async getModel(): Promise<vscode.LanguageModelChat | undefined> {
        // Prefer gpt-4o, fallback to gpt-4, then any copilot model
        let models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
        if (models.length === 0) {
            models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4' });
        }
        if (models.length === 0) {
            models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        }
        return models.length > 0 ? models[0] : undefined;
    }

    /** Prompt used when handing the ticket over to the GitHub Copilot Chat agent. */
    public static buildChatPrompt(contextPackage: any): string {
        const t = contextPackage.ticket;
        const files = contextPackage.relevantFiles || [];
        const fileListStr = files.map((f: any) => `- ${f.relativePath}`).join('\n');

        return `Implement Azure DevOps ticket #${t.id}.

Title: ${t.title}

Description:
${this.stripHtml(t.description)}

Likely relevant files:
${fileListStr}

Read those files, then make the code changes directly in the workspace. Keep changes minimal, production-ready, and do not modify unrelated functionality.`;
    }

    private static stripHtml(html: string): string {
        if (!html) { return ''; }
        return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    }

    private static buildPrompt(contextPackage: any): vscode.LanguageModelChatMessage[] {
        const t = contextPackage.ticket;
        const files = contextPackage.relevantFiles || [];

        const fileListStr = files.map((f: any) => `- ${f.relativePath}`).join('\n');
        const contentsStr = files.map((f: any) => `### ${f.relativePath}\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n');

        const userPrompt = `Ticket:
${t.title}

Description:
${t.description}

Relevant Files:
${fileListStr}

Contents:
${contentsStr}

Tasks:
1. Understand the ticket.
2. Explain the required changes.
3. Identify which files must change.
4. Give a short implementation plan.

Then output the final code.

OUTPUT FORMAT (mandatory, the extension parses this automatically):
For every file you change, emit a heading line with the workspace-relative path followed by a
fenced code block containing the COMPLETE final content of that file - not a diff, not a snippet,
not an excerpt, and never placeholders such as "// ... existing code ...".

### FILE: relative/path/to/file.ts
\`\`\`ts
<complete final file content>
\`\`\`

Repeat that pair for each changed file. Emit no file block for files you do not change.
Do not modify unrelated functionality. Keep changes minimal and production-ready.`;

        return [
            vscode.LanguageModelChatMessage.User(
                'You are a senior software engineer. You always return complete file contents in the requested format.'
            ),
            vscode.LanguageModelChatMessage.User(userPrompt)
        ];
    }
}
