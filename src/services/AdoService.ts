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
        project?: string
    ) {
        await context.secrets.store(this.PAT_KEY, pat);
        await context.secrets.store(this.ORG_KEY, orgUrl);
        if (project !== undefined) {
            await context.secrets.store(this.PROJECT_KEY, project);
        }
    }

    static async getProjects(
        context: vscode.ExtensionContext
    ): Promise<string[]> {

        const pat = await this.getPat(context);
        const orgUrl = await this.getOrgUrl(context);

        if (!pat || !orgUrl) {
            throw new Error("Not connected.");
        }

        const auth = this.makeAuth(pat);

        const response = await axios.get(
            `${orgUrl}/_apis/projects?api-version=7.1`,
            {
                headers: {
                    Authorization: `Basic ${auth}`
                }
            }
        );

        return response.data.value.map(
            (project: any) => project.name
        );
    }

    static async setProject(
        context: vscode.ExtensionContext,
        project: string
    ) {
        await context.secrets.store(
            this.PROJECT_KEY,
            project
        );
    }

    static async createPullRequest(
        context: vscode.ExtensionContext,
        input: {
        repositoryName: string;
        sourceBranch: string;
        targetBranch: string;
        title: string;
        description: string;
        }
    ): Promise<{ url?: string; id?: number }> {
        const pat = await this.getPat(context);
        const orgUrl = await this.getOrgUrl(context);
        const project = await this.getProject(context);
        if (!pat || !orgUrl || !project) {
            throw new Error('Connect to an Azure DevOps project before creating a pull request.');
        }

        const auth = this.makeAuth(pat);
        const headers = { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' };

        try {
            const repository = await this.getGitRepository(orgUrl, project, input.repositoryName, headers);
            const sourceRefName = this.toRefName(input.sourceBranch);
            const targetRefName = this.toRefName(input.targetBranch);

            await this.ensureBranchExists(orgUrl, project, repository.id, sourceRefName, headers, 'source');
            await this.ensureBranchExists(orgUrl, project, repository.id, targetRefName, headers, 'target');

            const response = await axios.post(
                `${orgUrl}/${encodeURIComponent(project)}/_apis/git/repositories/${repository.id}/pullrequests?api-version=7.1`,
                {
                    sourceRefName,
                    targetRefName,
                    title: input.title,
                    description: input.description
                },
                { headers }
            );

            return {
                id: response.data?.pullRequestId,
                url: response.data?._links?.web?.href ?? response.data?.url
            };
        } catch (error: any) {
            if (axios.isAxiosError(error)) {
                const detail = error.response?.data?.message
                    || error.response?.data?.value?.message
                    || error.response?.data?.error?.message
                    || error.message;
                throw new Error(`Pull request creation failed: ${detail}`);
            }

            throw error;
        }
    }

    private static async getGitRepository(
        orgUrl: string,
        project: string,
        repositoryName: string,
        headers: { Authorization: string; 'Content-Type': string }
    ): Promise<{ id: string; name: string }> {
        const response = await axios.get(
            `${orgUrl}/${encodeURIComponent(project)}/_apis/git/repositories?api-version=7.1`,
            { headers }
        );

        const repositories: Array<{ id: string; name: string }> = response.data?.value ?? [];
        const repository = repositories.find((repo) =>
            repo.name.toLowerCase() === repositoryName.toLowerCase()
        );

        if (repository) {
            return repository;
        }

        if (repositories.length === 1) {
            return repositories[0];
        }

        throw new Error(
            `Azure DevOps repository "${repositoryName}" was not found in project "${project}".`
        );
    }

    private static async ensureBranchExists(
        orgUrl: string,
        project: string,
        repositoryId: string,
        refName: string,
        headers: { Authorization: string; 'Content-Type': string },
        role: 'source' | 'target'
    ): Promise<void> {
        // The Azure DevOps "Get Refs" filter expects the ref without the leading "refs/" segment.
        const filter = refName.replace(/^refs\//, '');
        const response = await axios.get(
            `${orgUrl}/${encodeURIComponent(project)}/_apis/git/repositories/${repositoryId}/refs?filter=${encodeURIComponent(filter)}&api-version=7.1`,
            { headers }
        );

        const refs: Array<{ name: string }> = response.data?.value ?? [];
        const exists = refs.some((ref) => ref.name === refName);
        if (!exists) {
            throw new Error(
                `The ${role} branch "${refName.replace('refs/heads/', '')}" does not exist in Azure Repos. Push it to Azure DevOps or select a branch that exists there.`
            );
        }
    }

    private static toRefName(branch: string): string {
        return branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`;
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

        // Explicit TeamProject filter, since URL scoping alone isn't always honored by the WIQL endpoint
        const projectFilter = project
            ? ` AND [System.TeamProject] = '${project.replace(/'/g, "''")}'`
            : '';

        let wiqlResponse: any;
        try {
            wiqlResponse = await axios.post(
                wiqlUrl,
                {
                    query: `SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.State] <> 'Closed'${projectFilter} ORDER BY [System.ChangedDate] DESC`
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