const { Octokit } = require("@octokit/rest");

// Retry up to `maxAttempts` times with exponential backoff for transient errors
async function withRetry(fn, maxAttempts = 3, delayMs = 1500) {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const status = err.status || err.response?.status;
            const isTransient = !status || status >= 500 || status === 429;
            if (!isTransient || attempt === maxAttempts) throw err;
            console.warn(`[GitHub] Attempt ${attempt} failed (HTTP ${status}). Retrying in ${delayMs * attempt}ms...`);
            await new Promise(r => setTimeout(r, delayMs * attempt));
            lastErr = err;
        }
    }
    throw lastErr;
}

class GithubService {
    constructor() {
        this.octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    }

    async fetchRepoMetadata(owner, repo) {
        const { data } = await withRetry(() => this.octokit.repos.get({ owner, repo }));
        return data;
    }

    async fetchDefaultBranchRef(owner, repo) {
        const repoData = await this.fetchRepoMetadata(owner, repo);
        const defaultBranch = repoData.default_branch;

        const { data } = await this.octokit.git.getRef({
            owner,
            repo,
            ref: `heads/${defaultBranch}`,
        });
        return { defaultBranch, ref: data.object.sha };
    }

    async getLatestCommitsSince(owner, repo, sinceMinutes = 5) {
        const sinceDate = new Date(Date.now() - sinceMinutes * 60000).toISOString();
        const { data } = await this.octokit.repos.listCommits({
            owner,
            repo,
            since: sinceDate
        });
        return data; // Array of commits
    }

    async createTempBranch(owner, repo, newBranchName) {
        const { ref } = await this.fetchDefaultBranchRef(owner, repo);
        await this.octokit.git.createRef({
            owner,
            repo,
            ref: `refs/heads/${newBranchName}`,
            sha: ref,
        });
        return newBranchName;
    }

    async fetchFileContent(owner, repo, path) {
        try {
            const { data } = await this.octokit.repos.getContent({
                owner,
                repo,
                path,
            });

            if (data.type === 'file') {
                const content = Buffer.from(data.content, 'base64').toString('utf8');
                return content;
            }
            return null;
        } catch (e) {
            console.error(`Error fetching file ${path}:`, e.message);
            return null;
        }
    }

    async fetchAllFiles(owner, repo) {
        const { ref } = await this.fetchDefaultBranchRef(owner, repo);
        const { data } = await withRetry(() => this.octokit.git.getTree({
            owner,
            repo,
            tree_sha: ref,
            recursive: "true"
        }));

        // Skip: binary folders, build artifacts, package caches
        const SKIP_DIRS = [
            'node_modules', '.git', 'dist/', 'build/', '__pycache__',
            '.cache/', 'coverage/', 'vendor/', 'target/', '.next/',
            'out/', '.venv/', 'venv/', '.idea/', '.vs/', '.vscode/'
        ];

        // Skip: binary/media file extensions
        const SKIP_EXTS = [
            '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
            '.mp4', '.mp3', '.wav', '.pdf', '.zip', '.tar', '.gz', '.rar',
            '.exe', '.dll', '.so', '.o', '.a', '.class', '.jar', '.bin',
            '.lock', '.min.js', '.min.css', '.map',
        ];

        const files = data.tree.filter(item => {
            if (item.type !== 'blob') return false;
            if (SKIP_DIRS.some(d => item.path.includes(d))) return false;
            if (SKIP_EXTS.some(e => item.path.endsWith(e))) return false;
            // Must have an extension (skip files like .gitignore with no dot)
            const basename = item.path.split('/').pop();
            return basename.includes('.') || basename.startsWith('.');
        });

        console.log(`[GitHub] fetchAllFiles: ${files.length} source files in ${owner}/${repo}`);
        return files;
    }


    async commitFileChanges(owner, repo, branch, path, content, message) {
        // Get file sha if it exists
        let fileSha;
        try {
            const { data: fileData } = await this.octokit.repos.getContent({
                owner,
                repo,
                path,
                ref: branch
            });
            fileSha = fileData.sha;
        } catch (e) {
            // File might not exist yet -> purely a new file
        }

        await this.octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            path,
            message,
            content: Buffer.from(content).toString('base64'),
            branch,
            sha: fileSha
        });
    }

    async createPullRequest(owner, repo, headBranch, title, body) {
        const { defaultBranch } = await this.fetchDefaultBranchRef(owner, repo);
        const { data } = await this.octokit.pulls.create({
            owner,
            repo,
            title,
            head: headBranch,
            base: defaultBranch,
            body
        });
        return data.html_url;
    }
}

module.exports = new GithubService();
