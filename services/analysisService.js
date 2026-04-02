const fs = require('fs');
const path = require('path');

const ANALYSIS_DIR = path.join(__dirname, '..', 'analysis');

/**
 * Walks the local cloneDir and writes a project analysis .txt file.
 *
 * Format:
 *   === PROJECT: owner/repo ===
 *   Generated: <timestamp>
 *
 *   === STRUCTURE ===
 *     src/lexer.cpp   (14.2 KB)
 *     src/parser.h    (2.1 KB)
 *     ...
 *
 *   Total: N files
 *
 * Returns the absolute path to the saved file.
 */
function buildAnalysisFromLocalClone(owner, repo, cloneDir) {
    if (!fs.existsSync(ANALYSIS_DIR)) {
        fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
    }

    const SKIP_DIRS = new Set([
        '.git', 'node_modules', 'dist', 'build', '__pycache__',
        '.cache', 'coverage', 'vendor', 'target', '.next',
        'out', '.venv', 'venv', '.idea', '.vs', '.vscode'
    ]);

    const SKIP_EXTS = new Set([
        '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
        '.mp4', '.mp3', '.wav', '.pdf', '.zip', '.tar', '.gz', '.rar',
        '.exe', '.dll', '.so', '.o', '.a', '.class', '.jar', '.bin',
        '.lock', '.min.js', '.min.css', '.map', '.woff', '.woff2', '.ttf',
    ]);

    const entries = [];

    function walk(dir, relBase = '') {
        let items;
        try { items = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }

        for (const item of items) {
            if (SKIP_DIRS.has(item.name)) continue;
            const relPath = relBase ? `${relBase}/${item.name}` : item.name;
            const fullPath = path.join(dir, item.name);

            if (item.isDirectory()) {
                walk(fullPath, relPath);
            } else if (item.isFile()) {
                const ext = path.extname(item.name).toLowerCase();
                if (SKIP_EXTS.has(ext)) continue;
                if (!ext && !item.name.startsWith('.')) continue;
                try {
                    const stat = fs.statSync(fullPath);
                    entries.push({ relPath, sizeKb: (stat.size / 1024).toFixed(1) });
                } catch { /* skip unreadable */ }
            }
        }
    }

    walk(cloneDir);
    entries.sort((a, b) => a.relPath.localeCompare(b.relPath));

    const lines = [];
    lines.push(`=== PROJECT: ${owner}/${repo} ===`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');
    lines.push('=== STRUCTURE ===');
    for (const e of entries) {
        lines.push(`  ${e.relPath}  (${e.sizeKb} KB)`);
    }
    lines.push('');
    lines.push(`Total: ${entries.length} files`);

    const slug = `${owner}-${repo}`.replace(/[^a-zA-Z0-9-_]/g, '-');
    const filePath = path.join(ANALYSIS_DIR, `${slug}.txt`);
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    return filePath;
}

module.exports = { buildAnalysisFromLocalClone, ANALYSIS_DIR };
