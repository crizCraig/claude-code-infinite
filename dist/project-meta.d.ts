export interface ProjectMeta {
    project_dir?: string;
    git_repo?: string;
    git_branch?: string;
    git_commit?: string;
}
export type GitRunner = (args: string[], cwd: string) => Promise<string | undefined>;
export declare function readProjectMeta(cwd?: string, git?: GitRunner): Promise<ProjectMeta>;
/**
 * `owner/repo` from a remote URL in any of git's forms (`https://…`,
 * `ssh://…`, `git@host:owner/repo.git`, a local path): the last two path
 * segments, `.git` dropped. Host, user, password and query never survive.
 */
export declare function repoNameFromRemote(remote: string): string | undefined;
//# sourceMappingURL=project-meta.d.ts.map