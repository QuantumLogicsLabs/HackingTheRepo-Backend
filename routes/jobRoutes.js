const express = require("express");
const router = express.Router();
const agentController = require("../controllers/agentController");

router.get("/", agentController.getJobs);

router.get("/:id", agentController.getJobDetails);

module.exports = router;