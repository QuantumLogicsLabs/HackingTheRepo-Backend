const mongoose = require("mongoose");

const jobSchema = new mongoose.Schema({
    repoOwner: { type: String, required: true },
    repoName: { type: String, required: true },
    instructions: { type: String, required: true },
    status: { type: String, default: "pending", enum: ["pending", "in-progress", "completed", "failed"] },
    tempBranch: { type: String },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Job", jobSchema);
