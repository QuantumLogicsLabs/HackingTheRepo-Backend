require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

// ── Basic route (works even before DB is ready) ───────────────────────────────
app.get("/api/status", (req, res) => {
  const dbState = ["disconnected", "connected", "connecting", "disconnecting"];
  res.json({
    status: "Agent Backend Running",
    db: dbState[mongoose.connection.readyState] || "unknown"
  });
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);
  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

// Pass io instance to app so controllers can access it
app.set("io", io);
global.ioInstance = io;

app.get("/api/status", (req, res) => {
  res.json({ status: "Agent Backend Running", port: PORT });
});

// ── MongoDB connection ────────────────────────────────────────────────────────
// BUG FIX 1: The Atlas URI was missing a database name — appended
//            "quantum-code-agent" before the query string so Mongoose
//            knows which DB to use (without it, buffered ops time out).
// BUG FIX 2: Routes, cron, and server.listen are now ALL started inside
//            the .then() callback so nothing attempts a DB write before
//            the connection is confirmed open.
const MONGO_URI = process.env.MONGO_URI
  ? process.env.MONGO_URI.replace(
      /(\?|$)/,          // insert db name right before the query string (or at end)
      (match) => `quantum-code-agent${match}`
    )
  : "mongodb://127.0.0.1:27017/quantum-code-agent";

mongoose
  .connect(MONGO_URI, {
    serverSelectionTimeoutMS: 15000,   // fail fast if Atlas is unreachable
    socketTimeoutMS: 45000,
    connectTimeoutMS: 15000,
  })
  .then(async () => {
    console.log("✅ Connected to MongoDB");

    // ── Register API routes AFTER DB is ready ────────────────────────────
    const agentRoutes = require("./routes/agentRoutes");
    app.use("/api/agent", agentRoutes);

    // ── Start cron AFTER DB is ready ─────────────────────────────────────
    require("./services/cronService");
    console.log("✅ Cron service started");

    // ── Start HTTP server AFTER DB is ready ──────────────────────────────
    server.listen(PORT, async () => {
      console.log(`✅ Server listening on port ${PORT}`);

      // Vector DB init is non-blocking — failures are non-fatal
      const vectorService = require("./services/vectorService");
      try {
        await vectorService.init();
      } catch (vecErr) {
        console.warn("⚠️  VectorService init failed (non-fatal):", vecErr.message);
      }
    });
  })
  .catch((err) => {
    console.error("❌ MongoDB connection failed:", err.message);
    console.error("   Check your MONGO_URI in backend/.env");
    process.exit(1); // Exit clearly so the error is visible in logs
  });



// ── Handle unexpected disconnects after startup ───────────────────────────────
mongoose.connection.on("disconnected", () => {
  console.warn("⚠️  MongoDB disconnected. Mongoose will attempt to reconnect automatically.");
});

mongoose.connection.on("reconnected", () => {
  console.log("✅ MongoDB reconnected.");
});

// Setup complete by Fahad
