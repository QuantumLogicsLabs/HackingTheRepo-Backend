const mongoose = require("mongoose");

const lessonSchema = new mongoose.Schema({
    repository: { type: String, required: true },
    actionContext: { type: String, required: true }, // E.g., "Fixing Auth Bug"
    lessonLearned: { type: String, required: true }, // The actual takeaway
    timestamp: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Lesson", lessonSchema);
