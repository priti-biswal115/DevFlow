import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

type GitRepository = {
    rootUri: vscode.Uri;
    state: {
        refs: Array<{ name?: string; type?: number | string }>;
        HEAD?: { name?: string };
        workingTreeChanges?: unknown[];
    };
    checkout(ref: string): Promise<void>;
    pull(): Promise<void>;
    createBranch(name: string, checkout?: boolean, startPoint?: string): Promise<void>;
};

type GitApi = {
    repositories: GitRepository[];
    getRepository?: (uri: vscode.Uri) => GitRepository | undefined;
};

export class GitService {
    private static async getRepository(): Promise<GitRepository> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('Open a workspace folder containing a Git repository first.');
        }

        const gitExtension = vscode.extensions.getExtension('vscode.git');
        if (!gitExtension) {
            throw new Error('The built-in VS Code Git extension is unavailable.');
        }

        const gitExports = gitExtension.isActive
            ? gitExtension.exports
            : await gitExtension.activate();
        const gitApi = gitExports?.getAPI?.(1) as GitApi | undefined;
        if (!gitApi) {
            throw new Error('The built-in VS Code Git extension is unavailable or disabled.');
        }

        for (let attempt = 0; attempt < 10; attempt++) {
            const repository = gitApi.getRepository?.(workspaceFolder.uri)
                ?? gitApi.repositories.find((candidate) =>
                    workspaceFolder.uri.fsPath.toLowerCase().startsWith(candidate.rootUri.fsPath.toLowerCase())
                );

            if (repository) {
                return repository;
            }

            await new Promise((resolve) => setTimeout(resolve, 300));
        }

        throw new Error(`No Git repository found for ${workspaceFolder.uri.fsPath}.`);
    }

    public static async getBranches(): Promise<string[]> {
        const repository = await this.getRepository();

        const apiBranches = repository.state.refs
            .filter((ref) => {
                if (!ref.name) {
                    return false;
                }

                return ref.name.startsWith('refs/heads/')
                    || ref.type === 0
                    || ref.type === 'head'
                    || ref.type === 'Head';
            })
            .map((ref) => {
                const name = ref.name as string;
                return name.startsWith('refs/heads/')
                    ? name.slice('refs/heads/'.length)
                    : name;
            })
            .filter((name, index, branches) => branches.indexOf(name) === index);

        if (apiBranches.length > 0) {
            return apiBranches.sort((a, b) => a.localeCompare(b));
        }

        const result = await execFileAsync(
            'git',
            ['branch', '--format=%(refname:short)'],
            { cwd: repository.rootUri.fsPath }
        );

        return result.stdout
            .split(/\r?\n/)
            .map((branch) => branch.trim())
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b));
    }

    public static async getCurrentBranch(): Promise<string> {
        const repository = await this.getRepository();

        const headName = repository.state.HEAD?.name;
        if (headName) {
            return headName.startsWith('refs/heads/') ? headName.slice('refs/heads/'.length) : headName;
        }

        const result = await execFileAsync(
            'git',
            ['branch', '--show-current'],
            { cwd: repository.rootUri.fsPath }
        );

        return result.stdout.trim();
    }

    public static async getRepositoryName(): Promise<string> {
        const remoteUrl = await this.getRemoteUrl();
        const repoName = remoteUrl
            .replace(/\.git$/i, '')
            .split(/[/:\\]/)
            .filter(Boolean)
            .pop();

        if (!repoName) {
            throw new Error('Could not determine repository name from remote.origin.url.');
        }

        return repoName;
    }

    public static async getRemoteUrl(): Promise<string> {
        const repository = await this.getRepository();
        const result = await execFileAsync(
            'git',
            ['config', '--get', 'remote.origin.url'],
            { cwd: repository.rootUri.fsPath }
        );

        const remoteUrl = result.stdout.trim();
        if (!remoteUrl) {
            throw new Error('No remote.origin.url is configured for this repository.');
        }

        return remoteUrl;
    }

    public static async startWork(
        baseBranch: string,
        workingBranch: string
    ): Promise<void> {
        const repository = await this.getRepository();

        if (repository.state.workingTreeChanges?.length) {
            throw new Error(
                'Cannot switch branches because the repository has uncommitted changes. Commit or stash them, then try again.'
            );
        }

        try {
            await repository.checkout(baseBranch);
        } catch (error) {
            throw new Error(`Could not checkout base branch "${baseBranch}": ${this.errorMessage(error)}`);
        }

        try {
            await repository.pull();
        } catch (error) {
            throw new Error(`Could not pull base branch "${baseBranch}": ${this.errorMessage(error)}`);
        }

        const existingBranch = repository.state.refs.some((ref) => {
            const name = ref.name ?? '';
            return name === workingBranch || name === `refs/heads/${workingBranch}`;
        });

        try {
            if (existingBranch) {
                await repository.checkout(workingBranch);
            } else {
                await repository.createBranch(workingBranch, true, baseBranch);
            }
        } catch (error) {
            throw new Error(`Could not create or checkout working branch "${workingBranch}": ${this.errorMessage(error)}`);
        }
    }

    public static async checkoutBranch(branch: string): Promise<void> {
        const repository = await this.getRepository();
        try {
            await repository.checkout(branch);
        } catch (error) {
            throw new Error(`Could not checkout working branch "${branch}": ${this.errorMessage(error)}`);
        }
    }

    private static errorMessage(error: unknown): string {
        if (typeof error === 'object' && error !== null) {
            const gitError = error as { stderr?: string; message?: string };
            return gitError.stderr?.trim() || gitError.message || 'Git operation failed.';
        }

        return String(error);
    }

}
