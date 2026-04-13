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
 * Later runs → hard-reset working tree, then fetch + checkout default branch.
 *
 * THE FIX: Before switching branches we do:
 *   1. git reset --hard HEAD   — discards any uncommitted edits (AI leftovers)
 *   2. git clean -fd           — removes any untracked files the AI may have created
 * This guarantees a clean slate regardless of what the previous agent run left behind.
 */
async function cloneOrPull(owner, repo) {
    const cloneDir = getCloneDir(owner, repo);
    const token    = (process.env.GITHUB_TOKEN || '').trim();
    const cloneUrl = `https://${token}@github.com/${owner}/${repo}.git`;

    if (!fs.existsSync(CLONES_DIR)) {
        fs.mkdirSync(CLONES_DIR, { recursive: true });
    }

    if (fs.existsSync(path.join(cloneDir, '.git'))) {
        // ── Already cloned ──────────────────────────────────────────────────
        const git = simpleGit(cloneDir);

        // Always update the remote URL first (supports token rotation/fixes)
        await git.remote(['set-url', 'origin', cloneUrl]);

        // ── HARD RESET — discard all AI edits before switching branches ────
        // Without this, "git checkout main" fails with:
        // "Your local changes to the following files would be overwritten by checkout"
        try {
            await git.reset(['--hard', 'HEAD']);
            console.log('[gitService] Hard-reset to HEAD: working tree clean.');
        } catch (resetErr) {
            console.warn('[gitService] reset --hard failed (non-fatal):', resetErr.message);
        }

        // Remove untracked files/dirs (new files the agent may have created)
        try {
            await git.clean('fd', ['-f']);
            console.log('[gitService] Cleaned untracked files.');
        } catch (cleanErr) {
            console.warn('[gitService] git clean failed (non-fatal):', cleanErr.message);
        }

        // Detect default branch (main, master, develop, etc.)
        let defaultBranch = 'main';
        try {
            const remoteInfo = await git.remote(['show', 'origin']);
            const match = remoteInfo && remoteInfo.match(/HEAD branch:\s+(\S+)/);
            if (match) defaultBranch = match[1].trim();
        } catch { /* keep 'main' as fallback */ }

        // Fetch all remote refs
        await git.fetch(['origin', '--prune']);

        // Switch to default branch and reset to remote state
        // -B = create or reset the branch to the remote commit
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
    await git.addConfig('user.name',  process.env.GIT_NAME  || 'Quantum AI Agent');

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
 * Force-pushes the branch to origin.
 * Force is needed because the AI branch is always recreated from main.
 */
async function pushBranch(cloneDir, branchName) {
    const git    = simpleGit(cloneDir);
    const token  = process.env.GITHUB_TOKEN;

    // Re-set remote URL with auth token
    const remotes = await git.getRemotes(true);
    const origin  = remotes.find(r => r.name === 'origin');
    if (origin) {
        const baseUrl     = origin.refs.push.replace(/^https:\/\/(.*@)?/, '');
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