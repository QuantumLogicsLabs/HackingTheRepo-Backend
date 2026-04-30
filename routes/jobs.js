import express from "express";
import axios from "axios";
import Job from "../models/Job.js";
import User from "../models/User.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();

const REPOMIND_API = process.env.REPOMIND_API_URL || "http://localhost:8000";

// Slugify branch name
const toBranchName = (str) =>
  "repomind/" +
  str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 50);

/**
 * Validate that a pr_url is a real GitHub PR URL.
 * Rejects null, undefined, fake placeholder URLs like "https://github.com/fake/..."
 */
function isRealPrUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") return false;
    // Must match pattern: /owner/repo/pull/<number>
    const prPattern = /^\/[^/]+\/[^/]+\/pull\/\d+$/;
    return prPattern.test(parsed.pathname);
  } catch {
    return false;
  }
}

// POST /api/jobs — Create a new job
router.post("/", protect, async (req, res) => {
  try {
    const { repoUrl, instruction, branchName, prTitle } = req.body;
    if (!repoUrl || !instruction)
      return res
        .status(400)
        .json({ message: "repoUrl and instruction required" });

    const finalBranch = branchName || toBranchName(instruction);
    const finalTitle = prTitle || `repomind: ${instruction.slice(0, 60)}`;

    // Create job record
    const job = await Job.create({
      userId: req.user._id,
      repoUrl,
      instruction,
      branchName: finalBranch,
      prTitle: finalTitle,
      status: "queued",
    });

    // Fire off to RepoMind FastAPI (the bot uses its own token from server env)
    try {
      const rmRes = await axios.post(`${REPOMIND_API}/run`, {
        repo_url: repoUrl,
        instruction,
        branch_name: finalBranch,
        pr_title: finalTitle,
      });

      job.repomindJobId = rmRes.data.job_id;
      job.status = "running";
      await job.save();
    } catch (apiErr) {
      // RepoMind API not reachable — keep job as queued with error note
      job.status = "queued";
      job.errorMessage = `RepoMind API unreachable: ${apiErr.message}. Job saved, retry when API is up.`;
      await job.save();
    }

    // Increment user counter
    await User.findByIdAndUpdate(req.user._id, { $inc: { totalJobs: 1 } });

    res.status(201).json(job);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/jobs — List all jobs for user
router.get("/", protect, async (req, res) => {
  const jobs = await Job.find({ userId: req.user._id }).sort({ createdAt: -1 });
  res.json(jobs);
});

// GET /api/jobs/:id — Get single job
router.get("/:id", protect, async (req, res) => {
  const job = await Job.findOne({ _id: req.params.id, userId: req.user._id });
  if (!job) return res.status(404).json({ message: "Job not found" });
  res.json(job);
});

// GET /api/jobs/:id/status — Poll status from RepoMind
router.get("/:id/status", protect, async (req, res) => {
  try {
    const job = await Job.findOne({ _id: req.params.id, userId: req.user._id });
    if (!job) return res.status(404).json({ message: "Job not found" });

    if (!job.repomindJobId) return res.json(job);

    // Already terminal — no need to poll again
    if (job.status === "completed" || job.status === "failed")
      return res.json(job);

    // Poll RepoMind
    try {
      const rmRes = await axios.get(
        `${REPOMIND_API}/status/${job.repomindJobId}`,
      );
      const data = rmRes.data;

      if (data.status === "completed") {
        // Only store a prUrl if it is a real GitHub PR URL.
        // The old stub always returned "https://github.com/fake/repo/pull/1"
        // which caused the UI to show a fake PR link.
        const realPrUrl = isRealPrUrl(data.pr_url) ? data.pr_url : null;

        job.status = "completed";
        job.prUrl = realPrUrl;
        job.diffSummary = data.diff_summary || null;

        if (realPrUrl) {
          await User.findByIdAndUpdate(job.userId, {
            $inc: { successfulPRs: 1 },
          });
        }
      } else if (data.status === "failed") {
        job.status = "failed";
        job.errorMessage = data.error_message || data.error || "Unknown error";
      } else {
        job.status = "running";
      }

      await job.save();
    } catch {
      // API down — return current db state without crashing
    }

    res.json(job);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/jobs/:id/refine — Refine an existing PR
router.post("/:id/refine", protect, async (req, res) => {
  try {
    const { instruction } = req.body;
    if (!instruction)
      return res.status(400).json({ message: "instruction required" });

    const job = await Job.findOne({ _id: req.params.id, userId: req.user._id });
    if (!job) return res.status(404).json({ message: "Job not found" });

    job.refinements.push({ instruction });
    job.status = "running";

    try {
      await axios.post(`${REPOMIND_API}/refine`, {
        job_id: job.repomindJobId,
        instruction,
      });
    } catch {
      job.errorMessage = "RepoMind API unreachable for refinement";
    }

    await job.save();
    res.json(job);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/jobs/:id
router.delete("/:id", protect, async (req, res) => {
  await Job.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
  res.json({ message: "Deleted" });
});

export default router;
