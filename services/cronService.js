const cron = require("node-cron");
const agentController = require("../controllers/agentController");

// Runs every 5 minutes
cron.schedule("*/5 * * * *", async () => {
    console.log("[Cron] Running 5-minute schedule check for new commits on configured repos...");

    const reposEnv = process.env.GITHUB_REPOS;
    if (!reposEnv) {
        console.log("[Cron] GITHUB_REPOS is not configured. Skipping automated check.");
        return;
    }

    const repos = reposEnv.split(",").map(r => r.trim());

    for (const repoString of repos) {
        const [owner, name] = repoString.split("/");
        if (!owner || !name) continue;

        console.log(`[Cron] Checking ${owner}/${name}...`);
        // Passing a "cron" flag or leaving instructions as a default general "Improve or fix"
        const reqBody = {
            repoOwner: owner,
            repoName: name,
            instructions: "Analyze the latest commits and overall architecture, identify any bugs, missing tests, or obvious feature improvements, and implement them.",
            isCronJob: true
        };

        // We mock the req/res objects for the controller
        const req = {
            body: reqBody,
            app: { get: () => global.ioInstance } // Requires storing io globally
        };

        const res = {
            status: () => res,
            json: (data) => console.log(`[Cron Controller Ack]:`, data)
        };

        try {
            await agentController.runAgent(req, res);
        } catch (e) {
            console.error(`[Cron] Failed running agent on ${owner}/${name}:`, e.message);
        }
    }
});
