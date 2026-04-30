import express from "express";
import User from "../models/User.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();

// GET /api/settings
router.get("/", protect, async (req, res) => {
  const user = await User.findById(req.user._id);
  res.json({
    githubUsername: user.githubUsername,
    githubToken: user.githubToken ? "••••••••••••" + user.githubToken.slice(-4) : "",
    openaiKey: user.openaiKey ? "••••••••••••" + user.openaiKey.slice(-4) : "",
    hasGithubToken: !!user.githubToken,
    hasOpenaiKey: !!user.openaiKey,
  });
});

// PUT /api/settings
router.put("/", protect, async (req, res) => {
  try {
    const { githubUsername, githubToken, openaiKey } = req.body;
    const update = {};
    if (githubUsername !== undefined) update.githubUsername = githubUsername;
    if (githubToken && !githubToken.startsWith("••")) update.githubToken = githubToken;
    if (openaiKey && !openaiKey.startsWith("••")) update.openaiKey = openaiKey;

    const user = await User.findByIdAndUpdate(req.user._id, update, { new: true });
    res.json({ message: "Settings updated", githubUsername: user.githubUsername });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
