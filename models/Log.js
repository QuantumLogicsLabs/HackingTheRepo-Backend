const mongoose = require("mongoose");

const logSchema = new mongoose.Schema({
    jobId: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    message: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    type: { type: String, default: "info", enum: ["info", "success", "error", "warning"] }
});

module.exports = mongoose.model("Log", logSchema);
