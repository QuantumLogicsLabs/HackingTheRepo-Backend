const express = require("express");
const router = express.Router();
const agentController = require("../controllers/agentController");
const chatController = require("../controllers/chatController");

router.post("/run", agentController.runAgent);
router.get("/jobs", agentController.getJobs);
router.get("/jobs/:id", agentController.getJobDetails);

router.post("/chat", chatController.sendMessage);
router.get("/chat/:id", chatController.getChat);

module.exports = router;
