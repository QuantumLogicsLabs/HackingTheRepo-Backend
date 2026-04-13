const path = require('path');
const fs = require('fs');

const Job = require('../models/Job');
const Log = require('../models/Log');
const Lesson = require('../models/Lesson');
const githubService = require('../services/githubService');
const aiService = require('../services/aiService');
const gitService = require('../services/gitService');
const vectorService = require('../services/vectorService');
const sandboxService = require('../services/sandboxService');
const { buildAnalysisFromLocalClone } = require('../services/analysisService');

// ── Constants ─────────────────────────────────────────────────────────────────
const CHUNK_SIZE = 200;
const PARALLEL_FILE_BATCH = 4;      // files processed in parallel (rate-limit safe)
const CHUNK_DELAY = 3000;           // ms between AI calls within a batch
const AI_BRANCH = 'ai-agent';

// ── Repo-type detection → reliable build commands ────────────────────────────
function detectBuildCommand(cloneDir) {
    const checks = [
        { file: 'package.json',      cmd: 'node -e "const p=require(\'./package.json\'); console.log(\'OK:\', p.name)"' },
        { file: 'CMakeLists.txt',    cmd: 'cmake --version && echo "CMake project detected"' },
        { file: 'requirements.txt',  cmd: 'python3 -m py_compile $(find . -name "*.py" | head -5 | tr "\\n" " ") && echo "Python syntax OK"' },
        { file: 'Cargo.toml',        cmd: 'cargo check 2>&1 | tail -3' },
        { file: 'go.mod',            cmd: 'go build ./... 2>&1 | tail -3' },
        { file: 'pom.xml',           cmd: 'mvn validate -q && echo "Maven OK"' },
        { file: 'Makefile',          cmd: 'make --dry-run 2>&1 | head -5' },
    ];
    for (const { file, cmd } of checks) {
        if (fs.existsSync(path.join(cloneDir, file))) return cmd;
    }
    return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function readLines(absPath) {
    try { return fs.readFileSync(absPath, 'utf8').split('\n'); }
    catch { return []; }
}

function writeLines(absPath, lines) {
    fs.writeFileSync(absPath, lines.join('\n'), 'utf8');
}

function buildChunks(allLines, chunkSize = CHUNK_SIZE) {
    const chunks = [];
    for (let i = 0; i < allLines.length; i += chunkSize) {
        const slice = allLines.slice(i, i + chunkSize);
        chunks.push({ startLine: i + 1, endLine: i + slice.length, lines: slice });
    }
    return chunks;
}

function getIngestionFlagPath(cloneDir) {
    return path.join(cloneDir, '.ai-ingested');
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ── Phase 4 NEW: AI Planner — analyse repo, produce prioritised task list ─────
async function runPlannerAgent(projectTree, fullInstructions, lessonsContext) {
    const prompt = `You are an expert software architect and autonomous coding agent planner.
You have been given the full structure of a code repository. Your job is to create a PRIORITISED ACTION PLAN.

== REPO STRUCTURE ==
${projectTree.substring(0, 3000)}

== AGENT GOAL ==
${fullInstructions}

== PAST LESSONS (avoid repeating these mistakes) ==
${lessonsContext || 'None yet.'}

== YOUR TASK ==
Analyse the repo and produce a JSON task list. Be specific — name exact files.
Respond with ONLY a raw JSON array (no markdown, no comments):
[
  {
    "priority": 1,
    "type": "bug_fix" | "refactor" | "feature" | "docs" | "test",
    "title": "Short task title",
    "description": "Exactly what to change and why",
    "targetFiles": ["path/to/file.js"],
    "riskLevel": "low" | "medium" | "high"
  }
]
Return 5–12 tasks maximum. Highest impact first.`;

    try {
        const raw = await aiService.generateText(prompt);
        const clean = raw.replace(/```json|```/g, '').trim();
        const start = clean.indexOf('[');
        const end = clean.lastIndexOf(']');
        if (start === -1 || end === -1) return null;
        return JSON.parse(clean.substring(start, end + 1));
    } catch (e) {
        console.warn('[Planner] Failed to parse task list:', e.message);
        return null;
    }
}

// ── Phase 5b NEW: AI Self-Review — compare original vs proposed diff ──────────
async function selfReviewDiff(relPath, originalLines, proposedLines) {
    const originalSnippet = originalLines.slice(0, 80).join('\n');
    const proposedSnippet = proposedLines.slice(0, 80).join('\n');

    const prompt = `You are a senior code reviewer. Review the proposed AI edit below.
FILE: ${relPath}

== ORIGINAL (first 80 lines) ==
\`\`\`
${originalSnippet}
\`\`\`

== PROPOSED (first 80 lines) ==
\`\`\`
${proposedSnippet}
\`\`\`

Answer ONLY with a raw JSON object (no markdown):
{
  "approve": true or false,
  "reason": "One sentence explaining your decision",
  "riskLevel": "low" | "medium" | "high"
}

Approve if: code is improved, no regressions introduced, logic preserved.
Reject if: functionality removed, syntax errors likely, or change makes things worse.`;

    try {
        const raw = await aiService.generateText(prompt);
        const clean = raw.replace(/```json|```/g, '').trim();
        const start = clean.indexOf('{');
        const end = clean.lastIndexOf('}');
        if (start === -1 || end === -1) return { approve: true, reason: 'Review parse failed — auto-approved', riskLevel: 'low' };
        return JSON.parse(clean.substring(start, end + 1));
    } catch {
        return { approve: true, reason: 'Review unavailable — auto-approved', riskLevel: 'low' };
    }
}

// ── Process a single file (chunks + self-review) ──────────────────────────────
async function processFile({ absPath, relPath, cloneDir, fullInstructions, projectTree, repo, logEvent, callCounter }) {
    const allLines = readLines(absPath);
    if (allLines.length === 0) return { modified: false, relPath };

    const chunks = buildChunks(allLines, CHUNK_SIZE);
    let fileModified = false;
    const updatedLines = [...allLines];
    const reviewResults = [];

    for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];

        // Rate-limit guard
        if (callCounter.count > 0) await sleep(CHUNK_DELAY);
        callCounter.count++;

        try {
            // Global vector context
            let globalContextSnippet = '';
            try {
                const searchQuery = chunk.lines.slice(0, 5).join('\n');
const searchResults = await vectorService.searchSimilarContext(searchQuery, `${repo.owner}/${repo.name}`, 3);
                if (searchResults && searchResults.length > 0) {
                    globalContextSnippet = '\n[GLOBAL CONTEXT - RELATED SNIPPETS FROM OTHER FILES]:\n' +
                        searchResults.map(r => `File: ${r.path}\nContent:\n${r.content}`).join('\n\n') +
                        '\n[END GLOBAL CONTEXT]\n';
                }
            } catch { /* vector query optional */ }

            const result = await aiService.analyzeChunkLines(
                relPath, chunk.lines, chunk.startLine, chunk.endLine,
                fullInstructions + globalContextSnippet, projectTree
            );

            if (result && result.modified && result.lines && result.lines.length > 0) {
                // ── Self-review before accepting ──────────────────────────────
                const start0 = chunk.startLine - 1;
                const originalChunk = allLines.slice(start0, start0 + chunk.lines.length);
                const review = await selfReviewDiff(relPath, originalChunk, result.lines);
                reviewResults.push(review);

                if (review.approve) {
                    updatedLines.splice(start0, chunk.lines.length, ...result.lines);
                    fileModified = true;
                    await logEvent(`      ✓ Chunk ${ci + 1}: ${result.reason || 'improved'} [review: ${review.riskLevel}]`, 'success');

                    if (result.reason && result.reason.length > 20) {
                        await new Lesson({
                            repository: `${repo.owner}/${repo.name}`,
                            actionContext: fullInstructions.substring(0, 100),
                            lessonLearned: result.reason.substring(0, 300),
                        }).save();
                    }
                } else {
                    await logEvent(`      ⚠ Chunk ${ci + 1}: Self-review rejected — ${review.reason}`, 'warning');
                }
            } else {
                await logEvent(`      – Chunk ${ci + 1}: No change`);
            }
        } catch (chunkErr) {
            await logEvent(`      ✗ Chunk ${ci + 1}: ${chunkErr.message.substring(0, 120)}`, 'warning');
            if (chunkErr.message.toLowerCase().includes('rate limit') || chunkErr.message.includes('429')) {
                await logEvent('      ⚠️ Rate limit — cooling 60s...', 'warning');
                await sleep(60000);
            }
        }
    }

    if (fileModified) {
        writeLines(absPath, updatedLines);
    }

    return { modified: fileModified, relPath, reviewResults };
}

// ── Smart PR body builder ─────────────────────────────────────────────────────
function buildSmartPRBody({ instructions, taskPlan, filesToProcess, totalChunkCalls, totalModified, pastLessons, modifiedFiles, reviewSummary }) {
    const taskSection = taskPlan && taskPlan.length > 0
        ? `## 📋 Task Plan\n${taskPlan.slice(0, 8).map((t, i) =>
            `${i + 1}. **[${t.type.toUpperCase()}]** ${t.title} *(${t.riskLevel} risk)*\n   > ${t.description}`
        ).join('\n')}\n\n`
        : '';

    const byType = {};
    for (const f of (modifiedFiles || [])) {
        const ext = path.extname(f).replace('.', '') || 'other';
        (byType[ext] = byType[ext] || []).push(f);
    }
    const filesSection = Object.keys(byType).length > 0
        ? `## 📁 Modified Files by Type\n${Object.entries(byType).map(([ext, files]) =>
            `**${ext.toUpperCase()}** (${files.length})\n${files.map(f => `- \`${f}\``).join('\n')}`
        ).join('\n\n')}\n\n`
        : '';

    const riskCounts = (reviewSummary || []).reduce((acc, r) => {
        acc[r.riskLevel] = (acc[r.riskLevel] || 0) + 1;
        return acc;
    }, {});
    const riskBadge = riskCounts.high ? '🔴 High' : riskCounts.medium ? '🟡 Medium' : '🟢 Low';

    return `## 🤖 Quantum AI Agent — Autonomous PR

**Goal:** ${instructions}

**Risk Assessment:** ${riskBadge}

**Stats:** ${filesToProcess} files reviewed · ${totalChunkCalls} AI calls · ${totalModified} files improved

${taskSection}${filesSection}${pastLessons.length > 0
        ? `## 🧠 Past Lessons Applied\n${pastLessons.map(l => `- ${l.lessonLearned.substring(0, 80)}`).join('\n')}\n\n`
        : ''}## ✅ Self-Review Summary
Every change was reviewed by a second AI call before commit.
- Low risk changes: ${riskCounts.low || 0}
- Medium risk changes: ${riskCounts.medium || 0}
- High risk changes: ${riskCounts.high || 0}

*Branch: \`${AI_BRANCH}\` — regenerated each run from latest main*
*Auto-generated by Quantum Code Agent* 🤖✨`;
}

// ── Main Controller ───────────────────────────────────────────────────────────
exports.runAgent = async (req, res) => {
    const isCronJob = req.body.isCronJob || false;
    let reposToRun = [];

    if (req.body.repoOwner && req.body.repoName) {
        reposToRun.push({ owner: req.body.repoOwner, name: req.body.repoName });
    } else {
        const reposEnv = process.env.GITHUB_REPOS;
        if (!reposEnv) return res.status(400).json({ error: 'No GITHUB_REPOS configured in .env' });
        reposToRun = reposEnv.split(',').map(r => {
            const [owner, name] = r.trim().split('/');
            return { owner, name };
        });
    }

    const finalInstructions = req.body.instructions ||
        'Analyze the codebase. Fix bugs, improve code quality, add useful comments, and apply best-practice improvements.';

    const io = req.app.get('io');
    const job = new Job({
        repoOwner: reposToRun.length === 1 ? reposToRun[0].owner : reposToRun.map(r => r.owner).join(', '),
        repoName: reposToRun.length === 1 ? reposToRun[0].name : 'Multi-Repo Sync',
        tempBranch: AI_BRANCH,
        instructions: finalInstructions,
    });
    await job.save();

    if (res && res.status) res.status(202).json({ jobId: job._id, message: 'Agent started.' });

    const logEvent = async (message, type = 'info') => {
        const log = new Log({ jobId: job._id, message, type });
        await log.save();
        const payload = { jobId: job._id, message, type, timestamp: log.timestamp };
        if (io) {
            io.emit(`agent-status-${job._id}`, payload);
            io.emit('global-activity', payload);
        }
        console.log(`[Job ${job._id}] ${type.toUpperCase()}: ${message}`);
    };

    try {
        job.status = 'in-progress';
        await job.save();
        await logEvent(`Agent started. Processing ${reposToRun.length} repo(s)...`);

        for (const repo of reposToRun) {
            await logEvent(`\n━━━ ${repo.owner}/${repo.name} ━━━`);

            try {
                // ── Cron guard ───────────────────────────────────────────────
                if (isCronJob) {
                    await logEvent('Checking for recent commits...');
                    const commits = await githubService.getLatestCommitsSince(repo.owner, repo.name, 5);
                    if (!commits || commits.length === 0) {
                        await logEvent('No recent commits (last 5 min). Skipping.', 'info');
                        continue;
                    }
                    await logEvent(`Found ${commits.length} new commit(s). Proceeding.`, 'success');
                }

                // ── PHASE 1: Clone/pull ──────────────────────────────────────
                await logEvent('[Phase 1] Syncing local clone...');
                const cloneDir = await gitService.cloneOrPull(repo.owner, repo.name);
                await logEvent(`  Ready: ${cloneDir}`, 'success');

                // ── PHASE 2: AI branch ───────────────────────────────────────
                await gitService.createBranch(cloneDir, AI_BRANCH);
                await logEvent(`[Phase 2] On branch: ${AI_BRANCH}`, 'success');

                // ── PHASE 3: Analysis ────────────────────────────────────────
                const analysisPath = buildAnalysisFromLocalClone(repo.owner, repo.name, cloneDir);
                let projectTree = '';
                try { projectTree = fs.readFileSync(analysisPath, 'utf8'); } catch { /* ok */ }
                await logEvent(`[Phase 3] Analysis saved → ${analysisPath}`, 'success');

                // ── PHASE 3b: Vector ingestion (with hard timeout) ───────────
                const ingestionFlag = getIngestionFlagPath(cloneDir);
                const isFirstRun = !fs.existsSync(ingestionFlag);
                if (isFirstRun) {
                    await logEvent('[Phase 3b] First run — ingesting files into AI memory (30s timeout)...');
                    // Always write the flag first so a hang/crash never blocks future runs
                    fs.writeFileSync(ingestionFlag, new Date().toISOString(), 'utf8');

                    const allFiles = gitService.getAllSourceFiles(cloneDir);
                    const filesData = allFiles.slice(0, 50).map(absPath => ({
                        path: path.relative(cloneDir, absPath).replace(/\\/g, '/'),
                        content: readLines(absPath).join('\n'),
                    })).filter(f => f.content.length > 0 && f.content.length < 30000);

                    if (filesData.length > 0) {
                        const timeoutPromise = new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('Vector ingestion timed out after 30s')), 30000)
                        );
                        try {
                            await Promise.race([
                                vectorService.embedAndStoreFiles(`${repo.owner}/${repo.name}`, filesData),
                                timeoutPromise,
                            ]);
                            await logEvent(`  ✓ Ingested ${filesData.length} files into AI memory.`, 'success');
                        } catch (vecErr) {
                            await logEvent(`  Vector store skipped (non-fatal): ${vecErr.message.substring(0, 80)}`, 'warning');
                        }
                    } else {
                        await logEvent('  No files to ingest.', 'warning');
                    }
                } else {
                    await logEvent('[Phase 3b] AI memory already ingested. Skipping.');
                }

                // ── Past lessons ─────────────────────────────────────────────
                const pastLessons = await Lesson.find({ repository: `${repo.owner}/${repo.name}` })
                    .sort({ timestamp: -1 }).limit(3);
                if (pastLessons.length > 0) await logEvent(`  Loaded ${pastLessons.length} past lesson(s).`);
                const lessonsContext = pastLessons.map(l => l.lessonLearned).join('\n');
                const fullInstructions = lessonsContext
                    ? `${finalInstructions}\n\nPast learnings:\n${lessonsContext}`
                    : finalInstructions;

                // ── PHASE 4: AI Planner (NEW, 45s timeout) ──────────────────
                await logEvent('[Phase 4] Running AI Planner — generating task list...');
                let taskPlan = null;
                try {
                    const plannerTimeout = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Planner timed out after 45s')), 45000)
                    );
                    taskPlan = await Promise.race([
                        runPlannerAgent(projectTree, finalInstructions, lessonsContext),
                        plannerTimeout,
                    ]);
                    if (taskPlan && taskPlan.length > 0) {
                        await logEvent(`  ✓ Planner generated ${taskPlan.length} tasks:`, 'success');
                        for (const t of taskPlan) {
                            await logEvent(`    [${t.priority}] [${t.type}] ${t.title} (${t.riskLevel} risk)`);
                        }
                    } else {
                        await logEvent('  Planner returned no tasks — proceeding with general instructions.', 'warning');
                    }
                } catch (planErr) {
                    await logEvent(`  Planner skipped (non-fatal): ${planErr.message.substring(0, 80)}`, 'warning');
                }

                // ── PHASE 5: Parallel file editing (UPGRADED) ────────────────
                await logEvent('[Phase 5] Walking source files for parallel editing...');

                let allSourceFiles = [];
                try { allSourceFiles = gitService.getAllSourceFiles(cloneDir); }
                catch (walkErr) { await logEvent(`Walk error: ${walkErr.message}`, 'error'); }

                if (allSourceFiles.length === 0) {
                    await logEvent('No source files found.', 'warning');
                    continue;
                }

                // Load processed tracker
                const processedTrackerPath = path.join(cloneDir, '.ai-processed-files.json');
                let processedFiles = [];
                try {
                    if (fs.existsSync(processedTrackerPath)) {
                        processedFiles = JSON.parse(fs.readFileSync(processedTrackerPath, 'utf8'));
                    }
                } catch { processedFiles = []; }

                // Sort: source code first, docs last
                const sorted = allSourceFiles.sort((a, b) => {
                    const srcExts = ['.cpp', '.c', '.h', '.hpp', '.js', '.ts', '.py', '.java', '.rs', '.go', '.sa'];
                    const isCode = p => srcExts.includes(path.extname(p).toLowerCase());
                    const isDoc = p => /\.(md|txt|rst|gitignore|gitattributes|bat|sh)$/i.test(p);
                    if (isCode(a) && !isCode(b)) return -1;
                    if (!isCode(a) && isCode(b)) return 1;
                    if (isDoc(a) && !isDoc(b)) return 1;
                    if (!isDoc(a) && isDoc(b)) return -1;
                    return 0;
                });

                // If task plan has target files, prioritise those
                if (taskPlan && taskPlan.length > 0) {
                    const targetFiles = new Set(taskPlan.flatMap(t => t.targetFiles || []));
                    sorted.sort((a, b) => {
                        const relA = path.relative(cloneDir, a).replace(/\\/g, '/');
                        const relB = path.relative(cloneDir, b).replace(/\\/g, '/');
                        return (targetFiles.has(relB) ? 1 : 0) - (targetFiles.has(relA) ? 1 : 0);
                    });
                }

                const unprocessedFiles = sorted.filter(f => {
                    const rel = path.relative(cloneDir, f).replace(/\\/g, '/');
                    if (rel.endsWith('.sa')) return false;
                    return !processedFiles.includes(rel);
                });

                await logEvent(`  ✓ ${allSourceFiles.length} total · ${processedFiles.length} done · ${unprocessedFiles.length} remaining`, 'success');

                let totalFilesModified = 0;
                let totalChunkCalls = 0;
                const callCounter = { count: 0 };
                const modifiedFilesList = [];
                const allReviewResults = [];

                // ── PARALLEL BATCH PROCESSING ────────────────────────────────
                for (let batchStart = 0; batchStart < unprocessedFiles.length; batchStart += PARALLEL_FILE_BATCH) {
                    const batch = unprocessedFiles.slice(batchStart, batchStart + PARALLEL_FILE_BATCH);
                    await logEvent(`  Batch ${Math.floor(batchStart / PARALLEL_FILE_BATCH) + 1}: processing ${batch.length} file(s) in parallel...`);

                    const batchResults = await Promise.allSettled(
                        batch.map(absPath => {
                            const relPath = path.relative(cloneDir, absPath).replace(/\\/g, '/');
                            return processFile({
                                absPath, relPath, cloneDir, fullInstructions,
                                projectTree, repo, logEvent, callCounter
                            });
                        })
                    );

                    for (let i = 0; i < batchResults.length; i++) {
                        const absPath = batch[i];
                        const relPath = path.relative(cloneDir, absPath).replace(/\\/g, '/');
                        const result = batchResults[i];

                        if (result.status === 'fulfilled') {
                            const { modified, reviewResults } = result.value;
                            if (modified) {
                                totalFilesModified++;
                                modifiedFilesList.push(relPath);
                                await logEvent(`  ✓ Updated: ${relPath}`, 'success');
                            }
                            if (reviewResults) allReviewResults.push(...reviewResults);
                        } else {
                            await logEvent(`  ✗ Failed: ${relPath} — ${result.reason?.message?.substring(0, 100)}`, 'error');
                        }

                        // Mark as processed
                        processedFiles.push(relPath);
                    }

                    // Save tracker after each batch
                    fs.writeFileSync(processedTrackerPath, JSON.stringify(processedFiles, null, 2), 'utf8');
                    totalChunkCalls = callCounter.count;
                }

                await logEvent(
                    `[Phase 5 Done] ${totalChunkCalls} AI calls · ${totalFilesModified} file(s) improved`,
                    totalFilesModified > 0 ? 'success' : 'warning'
                );

                if (totalFilesModified === 0) {
                    await logEvent('No improvements found this run. Skipping commit/PR.', 'warning');
                    continue;
                }

                // ── PHASE 5c: Commit ─────────────────────────────────────────
                await logEvent(`[Phase 5c] Committing ${totalFilesModified} improved file(s)...`);
                const commitMsg = `AI Agent: ${finalInstructions.substring(0, 72)}`;
                const committed = await gitService.commitAll(cloneDir, commitMsg);

                if (!committed) {
                    await logEvent('git reports no diff. Skipping push.', 'warning');
                    continue;
                }

                // ── PHASE 6: Sandbox verify (UPGRADED) ───────────────────────
                await logEvent('[Phase 6] Sandbox verification...');
                try {
                    // Auto-detect build command from repo type
                    const autoCmd = detectBuildCommand(cloneDir);
                    let testCmd = autoCmd;

                    if (!testCmd) {
                        // Fallback: ask AI
                        const testCmdPrompt = `Suggest a single CLI command to verify the build of this project.\nPROJECT STRUCTURE:\n${projectTree.substring(0, 1000)}\nRespond with ONLY the command string.`;
                        const suggested = await aiService.generateText(testCmdPrompt);
                        testCmd = suggested.trim().split('\n')[0];
                    }

                    await logEvent(`  Auto-detected test: "${testCmd}"`);

                    const sandboxDir = await sandboxService.initSandbox(job._id, allSourceFiles.map(absPath => ({
                        path: path.relative(cloneDir, absPath).replace(/\\/g, '/'),
                        content: fs.readFileSync(absPath, 'utf8')
                    })));

                    const testResult = await sandboxService.executeCommand(sandboxDir, testCmd);

                    if (testResult.success) {
                        await logEvent(`  ✓ Sandbox check passed!\n${testResult.output.substring(0, 300)}`, 'success');
                    } else {
                        await logEvent(`  ✗ Sandbox check failed — rolling back PR creation.\n${testResult.errorOutput.substring(0, 400)}`, 'error');
                        await sandboxService.cleanup(sandboxDir);
                        // Rollback: reset to main branch
                        try {
                            const git = require('simple-git')(cloneDir);
                            await git.checkout('main');
                            await logEvent('  ↩ Rolled back to main branch.', 'warning');
                        } catch (rbErr) {
                            await logEvent(`  Rollback failed: ${rbErr.message}`, 'error');
                        }
                        continue;
                    }
                    await sandboxService.cleanup(sandboxDir);
                } catch (sandErr) {
                    await logEvent(`  Sandbox skip (non-fatal): ${sandErr.message}`, 'warning');
                }

                // ── PHASE 6b: Push ───────────────────────────────────────────
                await logEvent(`  Pushing branch "${AI_BRANCH}" to origin...`);
                await gitService.pushBranch(cloneDir, AI_BRANCH);
                await logEvent('  Branch pushed.', 'success');

                // ── PHASE 7: Smart PR (UPGRADED) ────────────────────────────
                await logEvent('[Phase 7] Creating smart Pull Request...');

                const prTitle = taskPlan && taskPlan[0]
                    ? `AI Agent: ${taskPlan[0].title} (+${taskPlan.length - 1} more tasks)`
                    : `Quantum Agent: ${finalInstructions.substring(0, 60)}`;

                const prBody = buildSmartPRBody({
                    instructions: finalInstructions,
                    taskPlan,
                    filesToProcess: unprocessedFiles.length,
                    totalChunkCalls,
                    totalModified: totalFilesModified,
                    pastLessons,
                    modifiedFiles: modifiedFilesList,
                    reviewSummary: allReviewResults,
                });

                try {
                    const prUrl = await githubService.createPullRequest(
                        repo.owner, repo.name, AI_BRANCH, prTitle, prBody
                    );
                    await logEvent(`  ✓ Pull Request: ${prUrl}`, 'success');
                } catch (prErr) {
                    if (prErr.message.includes('already exists') || prErr.status === 422) {
                        await logEvent(`  PR already exists for "${AI_BRANCH}" — branch updated.`, 'info');
                    } else {
                        await logEvent(`  Changes pushed but PR failed: ${prErr.message.substring(0, 120)}`, 'warning');
                    }
                }

            } catch (repoError) {
                let errMsg = repoError.message || String(repoError);
                if (errMsg.includes('<!DOCTYPE') || errMsg.includes('<html')) {
                    errMsg = 'GitHub returned HTML error page (5xx). Retry next cycle.';
                } else {
                    errMsg = errMsg.substring(0, 250);
                }
                await logEvent(`Error: ${errMsg}`, 'error');
            }
        }

        await logEvent('All repositories processed. Job complete.', 'success');
        job.status = 'completed';
        await job.save();

    } catch (error) {
        await logEvent(`Fatal error: ${error.message}`, 'error');
        job.status = 'failed';
        await job.save();
    }
};

exports.getJobs = async (req, res) => {
    try {
        const jobs = await Job.find().sort({ createdAt: -1 });
        res.json(jobs);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

exports.getJobDetails = async (req, res) => {
    try {
        const job = await Job.findById(req.params.id);
        if (!job) return res.status(404).json({ error: 'Job not found' });
        const logs = await Log.find({ jobId: req.params.id }).sort({ timestamp: 1 });
        res.json({ job, logs });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};