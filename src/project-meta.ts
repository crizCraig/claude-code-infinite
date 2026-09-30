/**
 * The project a ccc session runs in, sent with every MemTree call in
 * `x-client-meta` (cc-request.ts memtreeClientMeta) so the user can list and
 * search their sessions by project (`GET /v1/memtree/sessions?project=`).
 *
 * Read once at startup from the working directory: its name, the `origin`
 * remote reduced to `owner/repo` (never the URL, so no host, user or token
 * leaves the machine), the branch and the short HEAD commit. Every part is
 * optional: outside a git repository, with git missing, or when a command is
 * slow, the part is simply left out. Never throws.
 */
import { execFile } from "node:child_process";
import path from "node:path";

export interface ProjectMeta {
  project_dir?: string;
  git_repo?: string;
  git_branch?: string;
  git_commit?: string;
}

/** What the server keeps: short printable ASCII (client_session.py). */
const META_VALUE = /^[\x20-\x7e]{1,128}$/;
const GIT_TIMEOUT_MS = 1_500;

export type GitRunner = (args: string[], cwd: string) => Promise<string | undefined>;

export async function readProjectMeta(
  cwd: string = process.cwd(),
  git: GitRunner = runGit
): Promise<ProjectMeta> {
  const [remote, branch, commit] = await Promise.all([
    git(["remote", "get-url", "origin"], cwd),
    git(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    git(["rev-parse", "--short", "HEAD"], cwd),
  ]);
  const candidate: Record<string, string | undefined> = {
    project_dir: path.basename(path.resolve(cwd)),
    git_repo: remote ? repoNameFromRemote(remote) : undefined,
    git_branch: branch && branch !== "HEAD" ? branch : undefined,
    git_commit: commit && /^[0-9a-f]{4,40}$/.test(commit) ? commit : undefined,
  };
  const meta: Record<string, string> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (value && META_VALUE.test(value)) meta[key] = value;
  }
  return meta as ProjectMeta;
}

/**
 * `owner/repo` from a remote URL in any of git's forms (`https://…`,
 * `ssh://…`, `git@host:owner/repo.git`, a local path): the last two path
 * segments, `.git` dropped. Host, user, password and query never survive.
 */
export function repoNameFromRemote(remote: string): string | undefined {
  let pathPart = remote.trim();
  if (!pathPart) return undefined;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(pathPart);
  if (scheme) {
    try {
      pathPart = new URL(pathPart).pathname;
    } catch {
      return undefined;
    }
  } else {
    // scp-like `user@host:owner/repo`: everything after the first colon.
    const scp = /^[^/:]+:(.*)$/.exec(pathPart);
    if (scp) pathPart = scp[1];
  }
  const segments = pathPart
    .replace(/[?#].*$/, "")
    .split(/[/\\]+/)
    .filter(Boolean);
  if (!segments.length) return undefined;
  segments[segments.length - 1] = segments[segments.length - 1].replace(/\.git$/, "");
  const name = segments.slice(-2).join("/");
  return name && !name.includes("@") ? name : undefined;
}

function runGit(args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        "git",
        args,
        { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => resolve(err ? undefined : String(stdout).trim() || undefined)
      );
    } catch {
      resolve(undefined);
    }
  });
}
