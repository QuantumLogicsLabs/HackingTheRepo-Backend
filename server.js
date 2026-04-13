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

mongoose
  .connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/quantum-code-agent")
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));

io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);
  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

app.set("io", io);
global.ioInstance = io;

app.get("/api/status", (req, res) => {
  res.json({ status: "Agent Backend Running", port: PORT });
});

const agentRoutes = require("./routes/agentRoutes");
const chatRoutes  = require("./routes/chatRoutes");
const jobRoutes   = require("./routes/jobRoutes");

app.use("/api/agent", agentRoutes);
app.use("/api/chat",  chatRoutes);
app.use("/api/jobs",  jobRoutes);

require("./services/cronService");
const vectorService = require("./services/vectorService");

server.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  await vectorService.init();
});