const simpleGit = require('simple-git');
const fs = require('fs');
const path = require('path');

const CLONES_DIR = path.join(__dirname, '..', 'clones');

/** Returns the local clone directory path for a repo. */
function getCloneDir(owner, repo) {
    return path.join(CLONES_DIR, `${owner}-${repo}`);
}

/**
 * First run  → clones the repo into backend/clones/owner-repo/
 * Later runs → git fetch + checkout default branch + hard reset to origin
 *              (never does a bare pull to avoid AI-branch tracking issues)
 *
 * Returns the absolute path to the local clone directory.
 */
async function cloneOrPull(owner, repo) {
    const cloneDir = getCloneDir(owner, repo);
    const token = (process.env.GITHUB_TOKEN || '').trim();
    const cloneUrl = `https://${token}@github.com/${owner}/${repo}.git`;

    if (!fs.existsSync(CLONES_DIR)) {
        fs.mkdirSync(CLONES_DIR, { recursive: true });
    }

    if (fs.existsSync(path.join(cloneDir, '.git'))) {
        // ── Already cloned ──────────────────────────────────────────────────
        const git = simpleGit(cloneDir);

        // Always update the remote URL first (supports token rotation/fixes)
        await git.remote(['set-url', 'origin', cloneUrl]);

        // Detect default branch (main, master, develop, etc.)
        let defaultBranch = 'main';
        try {
            const remoteInfo = await git.remote(['show', 'origin']);
            const match = remoteInfo && remoteInfo.match(/HEAD branch:\s+(\S+)/);
            if (match) defaultBranch = match[1].trim();
        } catch { /* keep 'main' as fallback */ }

        // Fetch all remote refs without touching working tree
        await git.fetch(['origin', '--prune']);

        // Switch to default branch and hard-reset to remote state
        //  -B = create or reset the branch to the remote commit
        await git.checkout(['-B', defaultBranch, `origin/${defaultBranch}`]);

        console.log(`[gitService] Updated clone to origin/${defaultBranch}`);
    } else {
        // ── Fresh clone ─────────────────────────────────────────────────────
        console.log(`[gitService] Fresh clone of ${owner}/${repo}...`);
        await simpleGit().clone(cloneUrl, cloneDir);
        console.log(`[gitService] Clone complete → ${cloneDir}`);
    }

    return cloneDir;
}

/**
 * Creates (or re-creates) a local branch from the current HEAD.
 * -B means "create or reset to current position".
 */
async function createBranch(cloneDir, branchName) {
    const git = simpleGit(cloneDir);
    await git.checkout(['-B', branchName]);
    console.log(`[gitService] On branch: ${branchName}`);
    return branchName;
}

/**
 * Stages ALL changes and commits them.
 * Returns true if committed, false if there was nothing to commit.
 */
async function commitAll(cloneDir, message) {
    const git = simpleGit(cloneDir);

    // Configure git user so commits don't fail in CI-like environments
    await git.addConfig('user.email', process.env.GIT_EMAIL || 'ai-agent@hackingrepo.dev');
    await git.addConfig('user.name', process.env.GIT_NAME || 'Quantum AI Agent');

    await git.add('-A');
    const status = await git.status();
    if (status.files.length === 0) {
        console.log('[gitService] Nothing to commit.');
        return false;
    }
    await git.commit(message);
    console.log(`[gitService] Committed: "${message}"`);
    return true;
}

/**
 * Force-pushes the branch to origin. Force is needed because AI branches
 * are always created fresh from main — they never have a prior remote state.
 */
async function pushBranch(cloneDir, branchName) {
    const git = simpleGit(cloneDir);
    const token = process.env.GITHUB_TOKEN;

    // Re-set remote URL with auth token (sanitize existing token if any)
    const remotes = await git.getRemotes(true);
    const origin = remotes.find(r => r.name === 'origin');
    if (origin) {
        // Regex to extract the base URL after any existing auth: https://[user:pass@]github.com/...
        const baseUrl = origin.refs.push.replace(/^https:\/\/(.*@)?/, '');
        const urlWithToken = `https://${token}@${baseUrl}`;
        await git.remote(['set-url', 'origin', urlWithToken]);
    }

    await git.push('origin', branchName, ['--force']);
    console.log(`[gitService] Pushed: ${branchName}`);
}

/**
 * Returns absolute paths of all source files in the cloneDir.
 * Excludes binaries, build artifacts, and non-source directories.
 */
function getAllSourceFiles(cloneDir) {
    const SKIP_DIR_NAMES = [
        '.git', 'node_modules', 'dist', 'build', '__pycache__',
        '.cache', 'coverage', 'vendor', 'target', '.next',
        'out', '.venv', 'venv', '.idea', '.vs', '.vscode',
        'bin', 'obj', '.gradle',
    ];

    const SKIP_EXTS = [
        '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
        '.mp4', '.mp3', '.wav', '.pdf', '.zip', '.tar', '.gz', '.rar',
        '.exe', '.dll', '.so', '.o', '.a', '.class', '.jar', '.bin',
        '.lock', '.min.js', '.min.css', '.map', '.woff', '.woff2',
        '.ttf', '.eot', '.pdb', '.ilk',
    ];

    const results = [];

    function walk(dir) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            console.warn(`[gitService] Cannot read dir: ${dir} — ${e.message}`);
            return;
        }

        for (const entry of entries) {
            if (SKIP_DIR_NAMES.includes(entry.name.toLowerCase())) continue;

            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (SKIP_EXTS.includes(ext)) continue;
                if (!ext && !entry.name.startsWith('.')) continue;
                results.push(fullPath);
            }
        }
    }

    console.log(`[gitService] Walking: ${cloneDir}`);
    walk(cloneDir);
    console.log(`[gitService] Found ${results.length} source files`);
    return results;
}

module.exports = { cloneOrPull, createBranch, commitAll, pushBranch, getAllSourceFiles, getCloneDir };
