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

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/quantum-code-agent")
  .then(() => {
    console.log("Connected to MongoDB");
  }).catch((err) => {
    console.error("MongoDB connection error:", err);
  });


// Basic route
app.get("/api/status", (req, res) => {
  res.json({ status: "Agent Backend Running" });
});

io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

// Pass io instance to app
app.set("io", io);
global.ioInstance = io; // For cron

const agentRoutes = require("./routes/agentRoutes");
app.use("/api/agent", agentRoutes);

// Initialize Cron Jobs & Vector DB
require("./services/cronService");
const vectorService = require("./services/vectorService");

server.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  await vectorService.init();
});
