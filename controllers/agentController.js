const path = require('path');
const fs = require('fs');

const Job = require('../models/Job');
const Log = require('../models/Log');
const Lesson = require('../models/Lesson');
const githubService = require('../services/githubService');       // Octokit: PR + commit checks
const aiService = require('../services/aiService');
const gitService = require('../services/gitService');           // simple-git: clone/push/commit
const vectorService = require('../services/vectorService');
const sandboxService = require('../services/sandboxService');
const { buildAnalysisFromLocalClone } = require('../services/analysisService');

// ── Constants ─────────────────────────────────────────────────────────────────
const CHUNK_SIZE = 200;        // lines per AI call
const CHUNK_DELAY = 8000;       // ms between each chunk call (free-tier RPM guard)
// MAX_FILES limit removed so we can loop through the entirely of the directory
const AI_BRANCH = 'ai-agent'; // fixed branch name — no timestamp

// ── Helpers ──────────────────────────────────────────────────────────────────

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

/** Flag file that marks whether AI has already ingested this repo's files into vector store */
function getIngestionFlagPath(cloneDir) {
    return path.join(cloneDir, '.ai-ingested');
}

// ── Controller ────────────────────────────────────────────────────────────────

exports.runAgent = async (req, res) => {
    const isCronJob = req.body.isCronJob || false;
    let reposToRun = [];

    if (req.body.repoOwner && req.body.repoName) {
        reposToRun.push({ owner: req.body.repoOwner, name: req.body.repoName });
    } else {
        const reposEnv = process.env.GITHUB_REPOS;
        if (!reposEnv) {
            return res.status(400).json({ error: 'No GITHUB_REPOS configured in .env' });
        }
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

    if (res && res.status) {
        res.status(202).json({ jobId: job._id, message: 'Agent started.' });
    }

    // ── Logger ─────────────────────────────────────────────────────────────────
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

    // ── Main ───────────────────────────────────────────────────────────────────
    try {
        job.status = 'in-progress';
        await job.save();
        await logEvent(`Agent started. Processing ${reposToRun.length} repo(s)...`);

        for (const repo of reposToRun) {
            await logEvent(`\n━━━ ${repo.owner}/${repo.name} ━━━`);

            try {
                // ── Cron guard ──────────────────────────────────────────────
                if (isCronJob) {
                    await logEvent('Checking for recent commits...');
                    const commits = await githubService.getLatestCommitsSince(repo.owner, repo.name, 5); // last 5 min
                    if (!commits || commits.length === 0) {
                        await logEvent(`No recent commits (last 5 min). Skipping.`, 'info');
                        continue;
                    }
                    await logEvent(`Found ${commits.length} new commit(s). Proceeding.`, 'success');
                }

                // ── PHASE 1: Clone/pull to latest main ───────────────────────
                await logEvent(`[Phase 1] Syncing local clone...`);
                const cloneDir = await gitService.cloneOrPull(repo.owner, repo.name);
                await logEvent(`  Ready: ${cloneDir}`, 'success');

                // ── PHASE 2: Create (or reset) the fixed AI branch ───────────
                await gitService.createBranch(cloneDir, AI_BRANCH);
                await logEvent(`[Phase 2] On branch: ${AI_BRANCH}`, 'success');

                // ── PHASE 3: Analysis file ────────────────────────────────────
                const analysisPath = buildAnalysisFromLocalClone(repo.owner, repo.name, cloneDir);
                let projectTree = '';
                try { projectTree = fs.readFileSync(analysisPath, 'utf8'); } catch { /* ok */ }
                await logEvent(`[Phase 3] Analysis saved → ${analysisPath}`, 'success');

                // ── PHASE 3b: First-run ingestion into vector store ───────────
                const ingestionFlag = getIngestionFlagPath(cloneDir);
                const isFirstRun = !fs.existsSync(ingestionFlag);

                if (isFirstRun) {
                    await logEvent(`[Phase 3b] First run detected — ingesting all files into AI memory...`);
                    const allFiles = gitService.getAllSourceFiles(cloneDir);
                    const filesData = allFiles.slice(0, 100).map(absPath => ({
                        path: path.relative(cloneDir, absPath).replace(/\\/g, '/'),
                        content: readLines(absPath).join('\n'),
                    })).filter(f => f.content.length > 0);

                    if (filesData.length === 0) {
                        await logEvent(`  – No readable files found for memory ingestion.`, 'warning');
                        fs.writeFileSync(ingestionFlag, new Date().toISOString(), 'utf8');
                    } else {
                        try {
                            await vectorService.embedAndStoreFiles(`${repo.owner}/${repo.name}`, filesData);
                            fs.writeFileSync(ingestionFlag, new Date().toISOString(), 'utf8');
                            await logEvent(`  ✓ Ingested ${filesData.length} files into AI memory.`, 'success');
                        } catch (vecErr) {
                            await logEvent(`  Vector store failed (non-fatal): ${vecErr.message.substring(0, 80)}`, 'warning');
                            fs.writeFileSync(ingestionFlag, new Date().toISOString(), 'utf8');
                        }
                    }
                } else {
                    await logEvent(`[Phase 3b] AI memory already ingested. Skipping re-ingestion.`);
                }

                // ── Past lessons for context ──────────────────────────────────
                const pastLessons = await Lesson.find({ repository: `${repo.owner}/${repo.name}` })
                    .sort({ timestamp: -1 })
                    .limit(3);
                if (pastLessons.length > 0) {
                    await logEvent(`  Loaded ${pastLessons.length} past lesson(s) into context.`);
                }
                const lessonsContext = pastLessons.map(l => l.lessonLearned).join('\n');
                const fullInstructions = lessonsContext
                    ? `${finalInstructions}\n\nPast learnings:\n${lessonsContext}`
                    : finalInstructions;

                // ── PHASE 4: Chunk-by-chunk AI editing ───────────────────────
                await logEvent(`[Phase 4] Walking source files...`);

                let allSourceFiles = [];
                try {
                    allSourceFiles = gitService.getAllSourceFiles(cloneDir);
                } catch (walkErr) {
                    await logEvent(`Walk error: ${walkErr.message}`, 'error');
                }

                if (allSourceFiles.length === 0) {
                    await logEvent('No source files found. Check clone directory.', 'warning');
                    continue;
                }

                // ── Load Processed Files Tracker ─────────────────────────────────
                const processedTrackerPath = path.join(cloneDir, '.ai-processed-files.json');
                let processedFiles = [];
                try {
                    if (fs.existsSync(processedTrackerPath)) {
                        processedFiles = JSON.parse(fs.readFileSync(processedTrackerPath, 'utf8'));
                    }
                } catch { processedFiles = []; }

                // Sort: actual source code first (.cpp, .h, .js, .py), docs last
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

                // Filter out already processed files and intentionally skip .sa files from being edited
                const unprocessedFiles = sorted.filter(f => {
                    const rel = path.relative(cloneDir, f).replace(/\\/g, '/');
                    if (rel.endsWith('.sa')) return false;
                    return !processedFiles.includes(rel);
                });

                const filesToProcess = unprocessedFiles;
                await logEvent(`  ✓ ${allSourceFiles.length} total files. ${processedFiles.length} already processed. Processing ${filesToProcess.length} remaining files...`, 'success');

                let totalFilesModified = 0;
                let totalChunkCallsDone = 0;  // tracks ALL calls (success + fail) for delay

                for (let fi = 0; fi < filesToProcess.length; fi++) {
                    const absPath = filesToProcess[fi];
                    const relPath = path.relative(cloneDir, absPath).replace(/\\/g, '/');
                    const allLines = readLines(absPath);

                    if (allLines.length === 0) continue;

                    const chunks = buildChunks(allLines, CHUNK_SIZE);
                    await logEvent(`  [File ${fi + 1}/${filesToProcess.length}] ${relPath} — ${allLines.length} lines, ${chunks.length} chunk(s)`);

                    let fileModified = false;
                    const updatedLines = [...allLines];

                    for (let ci = 0; ci < chunks.length; ci++) {
                        const chunk = chunks[ci];
                        await logEvent(`    → Chunk ${ci + 1}/${chunks.length}: lines ${chunk.startLine}–${chunk.endLine}`);

                        // ── Rate limit guard ─────────────────────────────────
                        // Delay BEFORE every call (not just on success) so RPM is respected
                        if (totalChunkCallsDone > 0) {
                            await new Promise(r => setTimeout(r, CHUNK_DELAY));
                        }
                        totalChunkCallsDone++;

                        try {
                            // ── GLOBAL CONTEXT RETRIEVAL ─────────────────────
                            let globalContextSnippet = "";
                            try {
                                const searchQuery = chunk.lines.slice(0, 5).join("\n");
                                const searchResults = await vectorService.queryFiles(`${repo.owner}/${repo.name}`, searchQuery, 3);
                                if (searchResults && searchResults.length > 0) {
                                    globalContextSnippet = "\n[GLOBAL CONTEXT - RELATED SNIPPETS FROM OTHER FILES]:\n" +
                                        searchResults.map(r => `File: ${r.path}\nContent:\n${r.content}`).join("\n\n") +
                                        "\n[END GLOBAL CONTEXT]\n";
                                }
                            } catch (qErr) {
                                console.log("[agentController] Vector query skip:", qErr.message);
                            }

                            const result = await aiService.analyzeChunkLines(
                                relPath,
                                chunk.lines,
                                chunk.startLine,
                                chunk.endLine,
                                fullInstructions + globalContextSnippet,
                                projectTree
                            );

                            if (result && result.modified && result.lines && result.lines.length > 0) {
                                const start0 = chunk.startLine - 1;  // 0-indexed
                                updatedLines.splice(start0, chunk.lines.length, ...result.lines);
                                fileModified = true;
                                await logEvent(`      ✓ Improved: ${result.reason || 'changes applied'}`, 'success');

                                // Save any lessons
                                if (result.reason && result.reason.length > 20) {
                                    await new Lesson({
                                        repository: `${repo.owner}/${repo.name}`,
                                        actionContext: finalInstructions.substring(0, 100),
                                        lessonLearned: result.reason.substring(0, 300),
                                    }).save();
                                }
                            } else {
                                await logEvent(`      – No change`);
                            }
                        } catch (chunkErr) {
                            await logEvent(`      ✗ ${chunkErr.message.substring(0, 120)}`, 'warning');
                            // Smart Backoff: If we hit a rate limit, pause for 60s
                            if (chunkErr.message.toLowerCase().includes('rate limit') || chunkErr.message.includes('429')) {
                                await logEvent(`      ⚠️ Rate limit hit. Cooling down for 60s...`, 'warning');
                                await new Promise(r => setTimeout(r, 60000));
                            }
                        }
                    }

                    if (fileModified) {
                        writeLines(absPath, updatedLines);
                        totalFilesModified++;
                        await logEvent(`  ✓ Updated: ${relPath}`, 'success');
                    }

                    // Always mark this file as processed 
                    processedFiles.push(relPath);
                    fs.writeFileSync(processedTrackerPath, JSON.stringify(processedFiles, null, 2), 'utf8');

                } // end for files

                await logEvent(
                    `[Phase 4 Done] ${totalChunkCallsDone} AI calls made. ${totalFilesModified} file(s) modified.`,
                    totalFilesModified > 0 ? 'success' : 'warning'
                );

                if (totalFilesModified === 0) {
                    await logEvent('No improvements found this run. Skipping commit/PR.', 'warning');
                    continue;
                }

                // ── PHASE 5: git add + commit ────────────────────────────────
                await logEvent(`[Phase 5] Committing ${totalFilesModified} improved file(s)...`);
                const commitMsg = `AI Agent: ${finalInstructions.substring(0, 72)}`;
                const committed = await gitService.commitAll(cloneDir, commitMsg);

                if (!committed) {
                    await logEvent('git reports no diff. Skipping push.', 'warning');
                    continue;
                }

                // ── PHASE 5b: Sandbox Verification ───────────────────────────
                await logEvent(`[Phase 5b] Initializing Sandbox for verification...`);
                try {
                    // Ask AI for a test command
                    const testCmdPrompt = `
You have upgraded a repository. Suggest a single CLI command to verify the build or tests (e.g. "npm test", "make", "pytest", "gcc main.c -o main").
PROJECT STRUCTURE:
${projectTree.substring(0, 1500)}

Respond with ONLY the command string, nothing else.`;
                    const suggestedCmd = await aiService.generateText(testCmdPrompt); // Uses fallback chain
                    const testCmd = suggestedCmd.trim().split('\n')[0]; // take first line

                    await logEvent(`  Executing suggested test: "${testCmd}"`);

                    const sandboxDir = await sandboxService.initSandbox(job._id, allSourceFiles.map(absPath => ({
                        path: path.relative(cloneDir, absPath).replace(/\\/g, '/'),
                        content: fs.readFileSync(absPath, 'utf8')
                    })));

                    const testResult = await sandboxService.executeCommand(sandboxDir, testCmd);

                    if (testResult.success) {
                        await logEvent(`  ✓ Sandbox check passed!\n${testResult.output.substring(0, 300)}`, 'success');
                    } else {
                        await logEvent(`  ✗ Sandbox check failed. Aborting PR creation.\nOutput: ${testResult.errorOutput.substring(0, 400)}`, 'error');
                        await sandboxService.cleanup(sandboxDir);
                        continue;
                    }
                    await sandboxService.cleanup(sandboxDir);
                } catch (sandErr) {
                    await logEvent(`  Sandbox skip (non-fatal): ${sandErr.message}`, 'warning');
                }

                // ── PHASE 5c: Push ───────────────────────────────────────────
                await logEvent(`  Pushing branch "${AI_BRANCH}" to origin...`);
                await gitService.pushBranch(cloneDir, AI_BRANCH);
                await logEvent(`  Branch pushed.`, 'success');

                // ── PHASE 6: Create or update Pull Request ────────────────────
                await logEvent(`[Phase 6] Creating Pull Request...`);
                const prTitle = `Quantum Agent: ${finalInstructions.substring(0, 60)}`;
                const prBody =
                    `## 🤖 Quantum Code Agent\n\n` +
                    `**Goal:** ${finalInstructions}\n\n` +
                    `**Stats:** ${filesToProcess.length} files reviewed · ${totalChunkCallsDone} AI calls · ${totalFilesModified} files improved\n\n` +
                    (pastLessons.length > 0 ? `**Past Lessons Applied:**\n${pastLessons.map(l => `- ${l.lessonLearned.substring(0, 80)}`).join('\n')}\n\n` : '') +
                    `*Branch: \`${AI_BRANCH}\` — regenerated each run from latest main*\n\n` +
                    `*Auto-generated by Quantum Code Agent* 🤖✨`;

                try {
                    const prUrl = await githubService.createPullRequest(
                        repo.owner, repo.name, AI_BRANCH, prTitle, prBody
                    );
                    await logEvent(`  ✓ Pull Request: ${prUrl}`, 'success');
                } catch (prErr) {
                    // PR might already exist — that's fine
                    if (prErr.message.includes('already exists') || prErr.status === 422) {
                        await logEvent(`  Branch pushed. PR already exists for "${AI_BRANCH}" — update it manually.`, 'info');
                    } else {
                        await logEvent(`  Changes pushed but PR failed: ${prErr.message.substring(0, 120)}`, 'warning');
                    }
                }

            } catch (repoError) {
                let errMsg = repoError.message || String(repoError);
                if (errMsg.includes('<!DOCTYPE') || errMsg.includes('<html')) {
                    errMsg = 'GitHub returned an HTML error page (temporary 5xx). Retry next cycle.';
                } else {
                    errMsg = errMsg.substring(0, 250);
                }
                await logEvent(`Error: ${errMsg}`, 'error');
            }
        } // end for repos

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
