import express from "express";
import User from "../models/User.js";
import { protect } from "../middleware/auth.js";
import { settingsSchema, validate } from "../middleware/validate.js";
import { decryptSecret, encryptSecret, maskSecret } from "../utils/crypto.js";

const router = express.Router();

// GET /api/settings
router.get("/", protect, async (req, res) => {
  const user = await User.findById(req.user._id);
  const githubToken = decryptSecret(user.githubToken);
  const groqKey = decryptSecret(user.groqKey);

  res.json({
    githubUsername: user.githubUsername,
    githubToken: githubToken ? maskSecret(user.githubToken) : "",
    groqKey: groqKey ? maskSecret(user.groqKey) : "",
    hasGithubToken: !!githubToken,
    hasGroqKey: !!groqKey,
  });
});

// PUT /api/settings
router.put("/", protect, validate(settingsSchema), async (req, res) => {
  try {
    const { githubUsername, githubToken, groqKey } = req.body;
    const update = {};
    if (githubUsername !== undefined) update.githubUsername = githubUsername;
    if (githubToken && !githubToken.startsWith("••")) {
      update.githubToken = encryptSecret(githubToken);
    }
    if (groqKey && !groqKey.startsWith("••")) {
      update.groqKey = encryptSecret(groqKey);
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({
        message: "No settings fields to update",
        code: "VALIDATION_ERROR",
      });
    }

    const user = await User.findByIdAndUpdate(req.user._id, update, {
      new: true,
    });
    res.json({
      message: "Settings updated",
      githubUsername: user.githubUsername,
    });
  } catch (err) {
    res.status(500).json({ message: err.message, code: "INTERNAL_ERROR" });
  }
});

export default router;
