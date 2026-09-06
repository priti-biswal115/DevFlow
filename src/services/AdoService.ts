import * as vscode from 'vscode';
import axios from 'axios';
import { Ticket } from '../types/ticket';

export class AdoService {
    private static readonly PAT_KEY = 'devflow.pat';
    private static readonly ORG_KEY = 'devflow.orgUrl';
    private static readonly PROJECT_KEY = 'devflow.project';

    static async saveCredentials(
        context: vscode.ExtensionContext,
        pat: string,
        orgUrl: string,
        project: string
    ) {
        await context.secrets.store(this.PAT_KEY, pat);
        await context.secrets.store(this.ORG_KEY, orgUrl);
        await context.secrets.store(this.PROJECT_KEY, project);
    }

    static async clearCredentials(context: vscode.ExtensionContext) {
        await context.secrets.delete(this.PAT_KEY);
        await context.secrets.delete(this.ORG_KEY);
        await context.secrets.delete(this.PROJECT_KEY);
    }

    static async getPat(context: vscode.ExtensionContext) {
        return context.secrets.get(this.PAT_KEY);
    }

    static async getOrgUrl(context: vscode.ExtensionContext) {
        return context.secrets.get(this.ORG_KEY);
    }

    static async getProject(context: vscode.ExtensionContext) {
        return context.secrets.get(this.PROJECT_KEY);
    }

    private static makeAuth(pat: string): string {
        return Buffer.from(`:${pat}`).toString('base64');
    }

    static async validateConnection(
        context: vscode.ExtensionContext
    ): Promise<boolean> {
        const pat = await this.getPat(context);
        const orgUrl = await this.getOrgUrl(context);

        if (!pat || !orgUrl) {
            return false;
        }

        try {
            const auth = this.makeAuth(pat);
            await axios.get(
                `${orgUrl}/_apis/projects?api-version=7.1`,
                { headers: { Authorization: `Basic ${auth}` } }
            );
            return true;
        } catch {
            return false;
        }
    }

    static async getCurrentUser(context: vscode.ExtensionContext) {
        const pat = await this.getPat(context);
        const orgUrl = await this.getOrgUrl(context);
        const auth = this.makeAuth(pat!);

        const response = await axios.get(
            `${orgUrl}/_apis/connectionData?connectOptions=IncludeServices&lastChangeId=-1&lastChangeId64=-1`,
            { headers: { Authorization: `Basic ${auth}` } }
        );
        return response.data.authenticatedUser;
    }

    static async getAssignedTickets(
        context: vscode.ExtensionContext
    ): Promise<Ticket[]> {
        const pat = await this.getPat(context);
        const orgUrl = await this.getOrgUrl(context);
        const project = await this.getProject(context);

        if (!pat || !orgUrl) {
            throw new Error('Not connected. Please connect to Azure DevOps first.');
        }

        const auth = this.makeAuth(pat);

        // WIQL: scoped to project if available so @Me resolves correctly
        const wiqlUrl = project
            ? `${orgUrl}/${encodeURIComponent(project)}/_apis/wit/wiql?api-version=7.1`
            : `${orgUrl}/_apis/wit/wiql?api-version=7.1`;

        let wiqlResponse: any;
        try {
            wiqlResponse = await axios.post(
                wiqlUrl,
                {
                    query: `SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.State] <> 'Closed' ORDER BY [System.ChangedDate] DESC`
                },
                {
                    headers: {
                        Authorization: `Basic ${auth}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
        } catch (err: any) {
            const detail = err.response?.data?.message || err.message;
            throw new Error(`WIQL query failed: ${detail}`);
        }

        const workItems: { id: number }[] = wiqlResponse.data?.workItems ?? [];
        const ids = workItems.map((w) => w.id).slice(0, 50);

        if (!ids.length) {
            return [];
        }

        // Fetch full work item details, requesting only the fields we need
        const fields = [
            'System.Id',
            'System.Title',
            'System.Description',
            'System.State',
            'System.AssignedTo',
            'System.CreatedDate'
        ].join(',');

        let workItemsResponse: any;
        try {
            workItemsResponse = await axios.get(
                `${orgUrl}/_apis/wit/workitems?ids=${ids.join(',')}&fields=${fields}&api-version=7.1`,
                { headers: { Authorization: `Basic ${auth}` } }
            );
        } catch (err: any) {
            const detail = err.response?.data?.message || err.message;
            throw new Error(`Work items fetch failed: ${detail}`);
        }

        const items: any[] = workItemsResponse.data?.value ?? [];

        return items.map((w: any) => ({
            id: w.id,
            title: w.fields?.['System.Title'] ?? '(no title)',
            description: w.fields?.['System.Description'] ?? '',
            assignedTo:
                w.fields?.['System.AssignedTo']?.displayName ??
                w.fields?.['System.AssignedTo']?.uniqueName ??
                '',
            createdDate: w.fields?.['System.CreatedDate'] ?? '',
            state: w.fields?.['System.State'] ?? ''
        }));
    }
}