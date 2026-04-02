const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');

const execAsync = util.promisify(exec);

class SandboxService {
    constructor() {
        this.sandboxBaseDir = path.join(__dirname, '..', '.sandbox');
    }

    async initSandbox(jobId, filesData) {
        const jobDir = path.join(this.sandboxBaseDir, jobId.toString());
        await fs.mkdir(jobDir, { recursive: true });

        // Write all files fetched from repo to the sandbox
        for (const file of filesData) {
            const filePath = path.join(jobDir, file.path);
            const dirName = path.dirname(filePath);
            await fs.mkdir(dirName, { recursive: true });
            await fs.writeFile(filePath, file.content, 'utf8');
        }

        return jobDir;
    }

    async updateSandboxFiles(jobDir, proposedChanges) {
        for (const change of proposedChanges) {
            const filePath = path.join(jobDir, change.path);
            const dirName = path.dirname(filePath);
            await fs.mkdir(dirName, { recursive: true });
            await fs.writeFile(filePath, change.content, 'utf8');
        }
    }

    async executeCommand(jobDir, command, timeoutMs = 15000) {
        try {
            // Provide a secure wrapper, with a timeout to prevent infinite loops the AI might create
            const { stdout, stderr } = await execAsync(`cd "${jobDir}" && ${command}`, { timeout: timeoutMs });
            return {
                success: true,
                output: stdout.trim() || "Command executed successfully with no stdout.",
                errorOutput: stderr.trim()
            };
        } catch (error) {
            return {
                success: false,
                output: error.stdout ? error.stdout.trim() : "",
                errorOutput: (error.stderr ? error.stderr.trim() : "") || error.message
            };
        }
    }

    async cleanup(jobDir) {
        try {
            await fs.rm(jobDir, { recursive: true, force: true });
        } catch (e) {
            console.error(`[Sandbox] Failed to cleanup ${jobDir}: ${e.message}`);
        }
    }
}

module.exports = new SandboxService();
