import * as vscode from 'vscode';
import { CopilotService } from './CopilotService';

export type CodeReviewSection =
    | 'Security Findings'
    | 'Dependency Findings'
    | 'Code Quality Findings'
    | 'Risk Assessment'
    | 'Recommendations';

export interface CodeReviewReport {
    sections: Record<CodeReviewSection, string>;
    errors: string[];
}

const sectionNames: CodeReviewSection[] = [
    'Security Findings',
    'Dependency Findings',
    'Code Quality Findings',
    'Risk Assessment',
    'Recommendations'
];

export class CodeReviewService {
    public static async runWorkspaceReview(
        onProgress?: (stage: string) => void,
        token?: vscode.CancellationToken
    ): Promise<CodeReviewReport> {
        const files = await this.collectWorkspaceFiles();
        const report: CodeReviewReport = {
            sections: {
                'Security Findings': '',
                'Dependency Findings': '',
                'Code Quality Findings': '',
                'Risk Assessment': '',
                'Recommendations': ''
            },
            errors: []
        };

        const analyses: Array<{ stage: string; prompt: string }> = [
            {
                stage: 'Security Scan',
                prompt: 'Review the supplied workspace files for security vulnerabilities, unsafe input handling, secrets, and insecure configuration. Return concise findings with severity and file references. If none are found, say so.'
            },
            {
                stage: 'Dependency Analysis',
                prompt: 'Review the supplied workspace manifests and lockfiles for dependency risks, outdated packages, vulnerable versions, and configuration issues. Return concise findings with package names and actionable upgrades. If none are found, say so.'
            },
            {
                stage: 'Code Review Analysis',
                prompt: 'Review the supplied workspace files for correctness, maintainability, error handling, and likely regressions. Return concise findings with severity and file references. If none are found, say so.'
            }
        ];

        for (const analysis of analyses) {
            if (token?.isCancellationRequested) {
                break;
            }

            onProgress?.(analysis.stage);
            try {
                const result = await CopilotService.executeAnalysis(
                    `${analysis.prompt}\n\nWorkspace files:\n${files}`,
                    token
                );
                const targetSection = analysis.stage === 'Security Scan'
                    ? 'Security Findings'
                    : analysis.stage === 'Dependency Analysis'
                        ? 'Dependency Findings'
                        : 'Code Quality Findings';
                report.sections[targetSection] = result.trim() || 'No findings reported.';
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                report.errors.push(`${analysis.stage}: ${message}`);
            }
        }

        report.sections['Risk Assessment'] = this.buildRiskAssessment(report);
        report.sections['Recommendations'] = this.buildRecommendations(report);
        return report;
    }

    private static async collectWorkspaceFiles(): Promise<string> {
        const uris = await vscode.workspace.findFiles(
            '**/*',
            '**/{node_modules,.git,out,dist,build,coverage}/**',
            150
        );
        const files: string[] = [];
        for (const uri of uris) {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const content = Buffer.from(bytes).toString('utf8');
            if (content.includes('\0')) {
                continue;
            }
            files.push(`### ${vscode.workspace.asRelativePath(uri)}\n${content.slice(0, 12000)}`);
        }
        return files.join('\n\n') || 'No readable workspace files were found.';
    }

    private static buildRiskAssessment(report: CodeReviewReport): string {
        if (report.errors.length === 0 && sectionNames.slice(0, 3).every((name) => report.sections[name])) {
            return 'Risk assessment is based on the security, dependency, and code quality findings above.';
        }
        return report.errors.length > 0
            ? `Risk assessment is incomplete because ${report.errors.length} analysis stage(s) failed.`
            : 'Risk assessment could not be completed.';
    }

    private static buildRecommendations(report: CodeReviewReport): string {
        if (report.errors.length > 0) {
            return 'Rerun the failed analysis stages after resolving the reported errors.';
        }
        return 'Prioritize high-severity findings, update affected dependencies, and rerun Code Review after changes.';
    }
}
