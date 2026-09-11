import * as vscode from 'vscode';

export interface TicketBranchSession {
    ticketId: number;
    branchName: string;
}

type SessionMap = Record<string, TicketBranchSession>;

export class BranchSessionService {
    private static readonly fileName = 'devflow-session.json';

    public static async saveTicketBranch(ticketId: number, branch: string): Promise<void> {
        const sessions = await this.readSessions();
        sessions[String(ticketId)] = { ticketId, branchName: branch };
        await this.writeSessions(sessions);
    }

    public static async getTicketBranch(ticketId: number): Promise<string | undefined> {
        const session = (await this.readSessions())[String(ticketId)];
        return session?.branchName;
    }

    public static async removeTicketBranch(ticketId: number): Promise<void> {
        const sessions = await this.readSessions();
        delete sessions[String(ticketId)];
        await this.writeSessions(sessions);
    }

    public static async hasTicketBranch(ticketId: number): Promise<boolean> {
        return Boolean(await this.getTicketBranch(ticketId));
    }

    private static getFileUri(): vscode.Uri {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            throw new Error('Open a workspace before saving branch sessions.');
        }
        return vscode.Uri.joinPath(folder.uri, '.vscode', this.fileName);
    }

    private static getDirectoryUri(): vscode.Uri {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            throw new Error('Open a workspace before saving branch sessions.');
        }
        return vscode.Uri.joinPath(folder.uri, '.vscode');
    }

    private static async readSessions(): Promise<SessionMap> {
        try {
            const content = await vscode.workspace.fs.readFile(this.getFileUri());
            return JSON.parse(Buffer.from(content).toString('utf8')) as SessionMap;
        } catch {
            return {};
        }
    }

    private static async writeSessions(sessions: SessionMap): Promise<void> {
        const fileUri = this.getFileUri();
        await vscode.workspace.fs.createDirectory(this.getDirectoryUri());
        await vscode.workspace.fs.writeFile(
            fileUri,
            Buffer.from(JSON.stringify(sessions, null, 2), 'utf8')
        );
    }
}
