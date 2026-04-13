const cron = require("node-cron");
const agentController = require("../controllers/agentController");

// ── Helper: mock req/res for controller ───────────────────────────────────────
function makeMockReqRes(reqBody) {
    const req = {
        body: reqBody,
        app: { get: () => global.ioInstance },
    };
    const res = {
        status: () => res,
        json: (data) => console.log('[Cron] Controller ack:', JSON.stringify(data).substring(0, 100)),
    };
    return { req, res };
}

// ── Smart instructions builder — rotates focus each run ──────────────────────
const INSTRUCTION_POOL = [
    'Analyze the codebase. Fix any bugs, remove dead code, and apply best-practice improvements.',
    'Improve error handling and add missing try/catch blocks throughout the codebase.',
    'Review all source files for code quality issues, improve readability and add useful comments.',
    'Look for performance bottlenecks and optimize hot-path code. Fix any obvious inefficiencies.',
    'Improve documentation: update README references, add JSDoc/docstring comments to functions.',
    'Find and fix security issues: sanitize inputs, fix insecure patterns, add missing validations.',
];

let instructionIndex = 0;
function getNextInstruction() {
    const instruction = INSTRUCTION_POOL[instructionIndex % INSTRUCTION_POOL.length];
    instructionIndex++;
    return instruction;
}

// ── Main cron: runs every 5 minutes ──────────────────────────────────────────
cron.schedule('*/5 * * * *', async () => {
    console.log('[Cron] ── 5-min check triggered ──');

    const reposEnv = process.env.GITHUB_REPOS;
    if (!reposEnv) {
        console.log('[Cron] GITHUB_REPOS not configured. Skipping.');
        return;
    }

    const repos = reposEnv.split(',').map(r => r.trim()).filter(Boolean);
    const instructions = getNextInstruction();

    for (const repoString of repos) {
        const [owner, name] = repoString.split('/');
        if (!owner || !name) {
            console.warn(`[Cron] Invalid repo format: "${repoString}". Expected owner/name.`);
            continue;
        }

        console.log(`[Cron] Processing ${owner}/${name} — "${instructions.substring(0, 60)}..."`);

        const { req, res } = makeMockReqRes({
            repoOwner: owner,
            repoName: name,
            instructions,
            isCronJob: true,
        });

        try {
            await agentController.runAgent(req, res);
        } catch (e) {
            console.error(`[Cron] Agent failed on ${owner}/${name}:`, e.message);
        }
    }

    console.log('[Cron] ── Run complete ──');
});

// ── Deep scan: runs once daily at 3am ────────────────────────────────────────
cron.schedule('0 3 * * *', async () => {
    console.log('[Cron] ── Daily deep scan triggered ──');

    const reposEnv = process.env.GITHUB_REPOS;
    if (!reposEnv) return;

    const repos = reposEnv.split(',').map(r => r.trim()).filter(Boolean);

    for (const repoString of repos) {
        const [owner, name] = repoString.split('/');
        if (!owner || !name) continue;

        console.log(`[Cron] Deep scan: ${owner}/${name}`);

        const { req, res } = makeMockReqRes({
            repoOwner: owner,
            repoName: name,
            instructions: 'Perform a comprehensive review of the entire codebase. Fix all bugs, improve architecture, enhance error handling, update documentation, and apply security best practices.',
            isCronJob: false, // Deep scan always runs regardless of recent commits
        });

        try {
            await agentController.runAgent(req, res);
        } catch (e) {
            console.error(`[Cron] Deep scan failed on ${owner}/${name}:`, e.message);
        }
    }
});

console.log('[Cron] Scheduled: 5-min checks + daily 3am deep scan.');