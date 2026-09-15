import * as vscode from 'vscode';
import { AdoService } from './AdoService';
import { GitService } from './GitService';
import { Ticket } from '../types/ticket';

export interface PullRequestInput {
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description: string;
}

export interface PullRequestResult {
    url?: string;
    id?: number;
}

export class PullRequestService {
    public static async getCurrentBranch(): Promise<string> {
        return GitService.getCurrentBranch();
    }

    public static async getAvailableTargetBranches(): Promise<string[]> {
        return GitService.getBranches();
    }

    public static generatePRTitle(ticket: Ticket): string {
        return `Fix #${ticket.id}: ${ticket.title}`;
    }

    public static generatePRDescription(ticket: Ticket): string {
        const summary = ticket.title.replace(/^#?\d+\s*/, '').trim();
        const description = ticket.description
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        return `Ticket: #${ticket.id}\n\nSummary:\n${summary}.\n\nFiles Changed:\n- Add files after reviewing changes\n\nTesting:\n- Application loads successfully\n- Relevant behavior verified\n\nImpact:\nUI/code update for the selected ticket\n\nDetails:\n${description}`;
    }

    public static async createPullRequest(
        context: vscode.ExtensionContext,
        ticket: Ticket,
        input: PullRequestInput
    ): Promise<PullRequestResult> {
        if (!input.sourceBranch.trim()) {
            throw new Error('Source branch is required.');
        }
        if (!input.targetBranch.trim()) {
            throw new Error('Target branch is required.');
        }
        if (input.sourceBranch === input.targetBranch) {
            throw new Error('Source and target branches must be different.');
        }

        const remoteUrl = await GitService.getRemoteUrl();
        if (/github\.com[:/]/i.test(remoteUrl)) {
            throw new Error('This workspace is connected to GitHub, but DevFlow currently creates Azure DevOps pull requests. Use an Azure Repos remote or add a GitHub PR flow.');
        }

        const repositoryName = await GitService.getRepositoryName();

        return AdoService.createPullRequest(context, {
            repositoryName,
            sourceBranch: input.sourceBranch.trim(),
            targetBranch: input.targetBranch.trim(),
            title: input.title.trim() || this.generatePRTitle(ticket),
            description: input.description.trim() || this.generatePRDescription(ticket)
        });
    }
}
