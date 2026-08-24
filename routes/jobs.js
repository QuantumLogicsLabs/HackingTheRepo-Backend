import express from "express";
import axios from "axios";
import Job from "../models/Job.js";
import User from "../models/User.js";
import { protect } from "../middleware/auth.js";
import {
  createJobSchema,
  refineSchema,
  validate,
} from "../middleware/validate.js";
import { decryptSecret } from "../utils/crypto.js";

const router = express.Router();

const REPOMIND_API = process.env.REPOMIND_API_URL || "http://localhost:8000";

const toBranchName = (str) =>
  "repomind/" +
  str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 50);

function isRealPrUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") return false;
    const prPattern = /^\/[^/]+\/[^/]+\/pull\/\d+$/;
    return prPattern.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function dispatchToRepoMind(job, user) {
  const githubToken = decryptSecret(user.githubToken);
  const openaiKey = decryptSecret(user.openaiKey);

  const rmRes = await axios.post(`${REPOMIND_API}/run`, {
    repo_url: job.repoUrl,
    instruction: job.instruction,
    branch_name: job.branchName,
    pr_title: job.prTitle,
    create_pr: !job.previewBeforePush,
    github_token: githubToken || undefined,
    openai_api_key: openaiKey || undefined,
  });

  job.repomindJobId = rmRes.data.job_id;
  job.status = "running";
  job.startedAt = job.startedAt || new Date();
  job.errorMessage = null;
  await job.save();
  return job;
}

// POST /api/jobs — Create a new job
router.post("/", protect, validate(createJobSchema), async (req, res) => {
  try {
    const {
      repoUrl,
      instruction,
      branchName,
      prTitle,
      previewBeforePush = false,
    } = req.body;

    const user = await User.findById(req.user._id);
    const githubToken = decryptSecret(user?.githubToken);
    const openaiKey = decryptSecret(user?.openaiKey);

    if (!githubToken || !openaiKey) {
      return res.status(400).json({
        message:
          "Save your GitHub token and OpenAI key in Settings before creating a job",
        code: "SETTINGS_REQUIRED",
      });
    }

    const finalBranch = branchName || toBranchName(instruction);
    const finalTitle = prTitle || `repomind: ${instruction.slice(0, 60)}`;

    const job = await Job.create({
      userId: req.user._id,
      repoUrl,
      instruction,
      branchName: finalBranch,
      prTitle: finalTitle,
      previewBeforePush: !!previewBeforePush,
      status: "queued",
    });

    try {
      await dispatchToRepoMind(job, user);
    } catch (apiErr) {
      job.status = "queued";
      job.errorMessage = `RepoMind API unreachable: ${apiErr.message}. Job saved, retry when API is up.`;
      await job.save();
    }

    await User.findByIdAndUpdate(req.user._id, { $inc: { totalJobs: 1 } });

    res.status(201).json(job);
  } catch (err) {
    res.status(500).json({ message: err.message, code: "INTERNAL_ERROR" });
  }
});

// GET /api/jobs — List jobs (all jobs if admin, own jobs otherwise)
router.get("/", protect, async (req, res) => {
  try {
    const isAdmin = req.user.role === "admin";
    const filter = isAdmin ? {} : { userId: req.user._id };
    // Admins can further scope to one user via ?userId=<id>
    if (isAdmin && req.query.userId) {
      filter.userId = req.query.userId;
    }

    const jobs = await Job.find(filter)
      .sort({ createdAt: -1 })
      .populate(isAdmin ? { path: "userId", select: "username email" } : []);

    res.json(jobs);
  } catch (err) {
    res.status(500).json({ message: err.message, code: "INTERNAL_ERROR" });
  }
});

// GET /api/jobs/:id — Get single job
router.get("/:id", protect, async (req, res) => {
  try {
    const isAdmin = req.user.role === "admin";
    const query = isAdmin
      ? { _id: req.params.id }
      : { _id: req.params.id, userId: req.user._id };
    const job = await Job.findOne(query).populate(
      isAdmin ? { path: "userId", select: "username email" } : [],
    );

    if (!job) {
      return res
        .status(404)
        .json({ message: "Job not found", code: "NOT_FOUND" });
    }
    res.json(job);
  } catch (err) {
    res.status(500).json({ message: err.message, code: "INTERNAL_ERROR" });
  }
});

// GET /api/jobs/:id/status — Poll status from RepoMind
router.get("/:id/status", protect, async (req, res) => {
  try {
    const job = await Job.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!job) {
      return res
        .status(404)
        .json({ message: "Job not found", code: "NOT_FOUND" });
    }

    if (!job.repomindJobId) return res.json(job);

    if (job.status === "completed" || job.status === "failed") {
      return res.json(job);
    }

    try {
      const rmRes = await axios.get(
        `${REPOMIND_API}/status/${job.repomindJobId}`,
      );
      const data = rmRes.data;

      if (data.status === "completed") {
        const realPrUrl = isRealPrUrl(data.pr_url) ? data.pr_url : null;

        job.status = "completed";
        job.prUrl = realPrUrl;
        job.diffSummary = data.diff_summary || null;
        job.diff = data.diff || null;
        job.finishedAt = new Date();
        job.errorMessage = null;

        if (realPrUrl) {
          await User.findByIdAndUpdate(job.userId, {
            $inc: { successfulPRs: 1 },
          });
        }
      } else if (data.status === "failed") {
        job.status = "failed";
        job.errorMessage = data.error_message || data.error || "Unknown error";
        job.finishedAt = new Date();
      } else {
        job.status = "running";
        job.startedAt = job.startedAt || new Date();
      }

      await job.save();
    } catch {
      // API down — return current db state without crashing
    }

    res.json(job);
  } catch (err) {
    res.status(500).json({ message: err.message, code: "INTERNAL_ERROR" });
  }
});

// POST /api/jobs/:id/refine
router.post(
  "/:id/refine",
  protect,
  validate(refineSchema),
  async (req, res) => {
    try {
      const { instruction } = req.body;

      const job = await Job.findOne({
        _id: req.params.id,
        userId: req.user._id,
      });
      if (!job) {
        return res
          .status(404)
          .json({ message: "Job not found", code: "NOT_FOUND" });
      }

      job.refinements.push({ instruction });
      job.status = "running";
      job.startedAt = job.startedAt || new Date();
      job.finishedAt = null;

      try {
        await axios.post(`${REPOMIND_API}/refine`, {
          job_id: job.repomindJobId,
          instruction,
        });
        job.errorMessage = null;
      } catch {
        job.errorMessage = "RepoMind API unreachable for refinement";
      }

      await job.save();
      res.json(job);
    } catch (err) {
      res.status(500).json({ message: err.message, code: "INTERNAL_ERROR" });
    }
  },
);

// POST /api/jobs/:id/open-pr — open PR after preview-only run
router.post("/:id/open-pr", protect, async (req, res) => {
  try {
    const job = await Job.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!job) {
      return res
        .status(404)
        .json({ message: "Job not found", code: "NOT_FOUND" });
    }

    if (job.prUrl) {
      return res.status(400).json({
        message: "Pull request already exists for this job",
        code: "PR_EXISTS",
      });
    }

    if (job.status !== "completed" || !job.repomindJobId) {
      return res.status(400).json({
        message: "Job must be completed with a preview before opening a PR",
        code: "NOT_READY",
      });
    }

    const user = await User.findById(req.user._id);
    const githubToken = decryptSecret(user?.githubToken);

    const rmRes = await axios.post(`${REPOMIND_API}/open-pr`, {
      job_id: job.repomindJobId,
      github_token: githubToken || undefined,
    });

    const prUrl = rmRes.data?.pr_url;
    if (!isRealPrUrl(prUrl)) {
      return res.status(502).json({
        message: "RepoMind did not return a valid PR URL",
        code: "INVALID_PR_URL",
      });
    }

    job.prUrl = prUrl;
    await job.save();
    await User.findByIdAndUpdate(job.userId, { $inc: { successfulPRs: 1 } });

    res.json(job);
  } catch (err) {
    res.status(502).json({
      message: err.response?.data?.detail || err.message || "Failed to open PR",
      code: "OPEN_PR_FAILED",
    });
  }
});

// POST /api/jobs/:id/retry — re-dispatch queued jobs when RepoMind was down
router.post("/:id/retry", protect, async (req, res) => {
  try {
    const job = await Job.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!job) {
      return res
        .status(404)
        .json({ message: "Job not found", code: "NOT_FOUND" });
    }

    if (job.status !== "queued") {
      return res.status(400).json({
        message: "Only queued jobs can be retried",
        code: "INVALID_STATUS",
      });
    }

    const user = await User.findById(req.user._id);
    try {
      await dispatchToRepoMind(job, user);
      res.json(job);
    } catch (apiErr) {
      job.errorMessage = `RepoMind API unreachable: ${apiErr.message}`;
      await job.save();
      res.status(502).json({
        message: job.errorMessage,
        code: "REPOMIND_UNREACHABLE",
        job,
      });
    }
  } catch (err) {
    res.status(500).json({ message: err.message, code: "INTERNAL_ERROR" });
  }
});

// DELETE /api/jobs/:id
router.delete("/:id", protect, async (req, res) => {
  try {
    const deleted = await Job.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!deleted) {
      return res
        .status(404)
        .json({ message: "Job not found", code: "NOT_FOUND" });
    }
    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message, code: "INTERNAL_ERROR" });
  }
});

export default router;
