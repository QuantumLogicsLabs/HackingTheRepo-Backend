const express = require("express");
const router = express.Router();
const agentController = require("../controllers/agentController");

router.post("/run", agentController.runAgent);

router.post("/analyze", (req, res) => {
  const { repoUrl } = req.body || {};

  if (!repoUrl || typeof repoUrl !== "string") {
    return res.status(400).json({ error: "repoUrl is required" });
  }

  let owner;
  let name;

  try {
    const url = new URL(repoUrl);
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    owner = parts[0];
    name = (parts[1] || "").replace(/\.git$/i, "");
  } catch {
    return res.status(400).json({ error: "Invalid repoUrl format" });
  }

  if (!owner || !name) {
    return res
      .status(400)
      .json({ error: "repoUrl must look like https://github.com/owner/repo" });
  }

  req.body.repoOwner = owner;
  req.body.repoName = name;
  return agentController.runAgent(req, res);
});

module.exports = router;