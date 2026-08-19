import mongoose from "mongoose";
import request from "supertest";
import jwt from "jsonwebtoken";
import { MongoMemoryServer } from "mongodb-memory-server";
import User from "../models/User.js";
import { encryptSecret } from "../utils/crypto.js";

let memoryServer;

export async function connectTestDb() {
  // CI provides a real Mongo service via MONGO_URI.
  if (process.env.CI === "true" && process.env.MONGO_URI) {
    await mongoose.connect(process.env.MONGO_URI);
    return;
  }

  memoryServer = await MongoMemoryServer.create();
  await mongoose.connect(memoryServer.getUri());
}

export async function clearDb() {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
}

export async function disconnectTestDb() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}

export async function createUserAndToken(overrides = {}) {
  const {
    stripSecrets = false,
    username,
    email,
    password,
    githubUsername,
    githubToken,
    openaiKey,
  } = overrides;

  const user = await User.create({
    username:
      username ||
      `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    email:
      email ||
      `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: password || "password123",
    githubUsername: githubUsername || "octocat",
    githubToken: stripSecrets
      ? ""
      : encryptSecret(githubToken || "ghp_testtoken1234"),
    openaiKey: stripSecrets
      ? ""
      : encryptSecret(openaiKey || "sk-testopenai1234"),
  });

  const token = jwt.sign(
    { id: user._id },
    process.env.JWT_SECRET || "secret",
    { expiresIn: "1h" },
  );

  return { user, token };
}

export function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

export function agent(app) {
  return request.agent(app);
}
