import mongoose from "mongoose";

const jobSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    repoUrl: { type: String, required: true },
    instruction: { type: String, required: true },
    branchName: { type: String, required: true },
    prTitle: { type: String, required: true },
    // The repomind job_id returned from FastAPI
    repomindJobId: { type: String, default: null },
    status: {
      type: String,
      enum: ["queued", "running", "completed", "failed", "refined"],
      default: "queued",
    },
    prUrl: { type: String, default: null },
    diffSummary: { type: String, default: null },
    errorMessage: { type: String, default: null },
    // Refinement history
    refinements: [
      {
        instruction: String,
        timestamp: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

export default mongoose.model("Job", jobSchema);
