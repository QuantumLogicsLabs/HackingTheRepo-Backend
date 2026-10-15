import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { pathToFileURL } from "url";

import authRoutes from "./routes/auth.js";
import jobRoutes from "./routes/jobs.js";
import settingsRoutes from "./routes/settings.js";
import assistantRoutes from "./routes/assistant.js";
import { errorHandler } from "./middleware/errorHandler.js";

dotenv.config();

const app = express();
const isProduction = process.env.NODE_ENV === "production";

if (isProduction && !process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is required in production");
}

const allowedOrigins = (
  process.env.FRONTEND_ORIGIN || "http://localhost:5173,http://localhost:3000"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: "1mb" }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.VITEST === "true" ? 10_000 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, try again later", code: "RATE_LIMITED" },
});

const jobCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.VITEST === "true" ? 10_000 : 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many job creates, try again later", code: "RATE_LIMITED" },
});

if (process.env.VITEST !== "true") {
  mongoose
    .connect(process.env.MONGO_URI || "mongodb://localhost:27017/repomind")
    .then(() => console.log("✅ MongoDB connected"))
    .catch((err) => console.error("❌ MongoDB error:", err));
}

app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/jobs", (req, res, next) => {
  if (req.method === "POST" && req.path === "/") {
    return jobCreateLimiter(req, res, next);
  }
  return next();
}, jobRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/assistant", assistantRoutes);

app.get("/api/health", (req, res) =>
  res.json({
    status: "ok",
    bot: process.env.REPOMIND_GITHUB_USERNAME || "repomind-bot",
  }),
);

app.use(errorHandler);

export default app;

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun && process.env.VITEST !== "true") {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () =>
    console.log(`🚀 Server running on http://localhost:${PORT}`),
  );
}
