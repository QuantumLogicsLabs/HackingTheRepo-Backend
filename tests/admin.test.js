import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { MongoMemoryServer } from "mongodb-memory-server";

import app from "../index.js";
import User from "../models/User.js";
import Job from "../models/Job.js";

const JWT_SECRET = process.env.JWT_SECRET || "secret";
let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  await mongoose.connect(mongoUri);
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});

async function createUser(overrides = {}) {
  const user = new User({
    username: `user_${Math.random().toString(36).substring(7)}`,
    email: `test_${Math.random().toString(36).substring(7)}@example.com`,
    password: "password123",
    role: "user",
    ...overrides,
  });
  await user.save();
  return user;
}

function getAuthCookie(user) {
  const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: "1h" });
  return `rm_session=${token}`;
}

describe("admin endpoints", () => {
  beforeEach(async () => {
    await User.deleteMany({});
    await Job.deleteMany({});
  });

  describe("access control", () => {
    it("requires auth", async () => {
      const res = await request(app).get("/api/admin/users");
      expect(res.status).toBe(401);
    });

    it("rejects non-admin users", async () => {
      const user = await createUser({ role: "user" });
      const cookie = getAuthCookie(user);

      const res = await request(app)
        .get("/api/admin/users")
        .set("Cookie", [cookie]);

      expect(res.status).toBe(403);
    });

    it("allows admin users", async () => {
      const admin = await createUser({ role: "admin" });
      const cookie = getAuthCookie(admin);

      const res = await request(app)
        .get("/api/admin/users")
        .set("Cookie", [cookie]);

      expect(res.status).toBe(200);
    });
  });

  describe("user listing", () => {
    it("never leaks secrets", async () => {
      const admin = await createUser({
        role: "admin",
        githubToken: "secret_github_token",
        openaiKey: "secret_openai_key",
      });
      const cookie = getAuthCookie(admin);

      const res = await request(app)
        .get("/api/admin/users")
        .set("Cookie", [cookie]);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const foundAdmin = res.body.find((u) => u._id === String(admin._id));
      expect(foundAdmin).toBeDefined();
      expect(foundAdmin.password).toBeUndefined();
      expect(foundAdmin.githubToken).toBeUndefined();
      expect(foundAdmin.openaiKey).toBeUndefined();
    });
  });

  describe("role management", () => {
    it("promotes a user to admin", async () => {
      const admin = await createUser({ role: "admin" });
      const targetUser = await createUser({ role: "user" });
      const cookie = getAuthCookie(admin);

      const res = await request(app)
        .patch(`/api/admin/users/${targetUser._id}/role`)
        .set("Cookie", [cookie])
        .send({ role: "admin" });

      expect(res.status).toBe(200);
      expect(res.body.role).toBe("admin");
    });

    it("demotes an admin to user", async () => {
      const admin = await createUser({ role: "admin" });
      const targetAdmin = await createUser({ role: "admin" });
      const cookie = getAuthCookie(admin);

      const res = await request(app)
        .patch(`/api/admin/users/${targetAdmin._id}/role`)
        .set("Cookie", [cookie])
        .send({ role: "user" });

      expect(res.status).toBe(200);
      expect(res.body.role).toBe("user");
    });

    it("rejects an invalid role", async () => {
      const admin = await createUser({ role: "admin" });
      const targetUser = await createUser({ role: "user" });
      const cookie = getAuthCookie(admin);

      const res = await request(app)
        .patch(`/api/admin/users/${targetUser._id}/role`)
        .set("Cookie", [cookie])
        .send({ role: "superadmin" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("blocks an admin from demoting themselves", async () => {
      const admin = await createUser({ role: "admin" });
      const cookie = getAuthCookie(admin);

      const res = await request(app)
        .patch(`/api/admin/users/${admin._id}/role`)
        .set("Cookie", [cookie])
        .send({ role: "user" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("SELF_DEMOTE_BLOCKED");

      const stillAdmin = await User.findById(admin._id);
      expect(stillAdmin.role).toBe("admin");
    });

    it("404s for a role change on a nonexistent user", async () => {
      const admin = await createUser({ role: "admin" });
      const cookie = getAuthCookie(admin);
      const fakeId = new mongoose.Types.ObjectId().toString();

      const res = await request(app)
        .patch(`/api/admin/users/${fakeId}/role`)
        .set("Cookie", [cookie])
        .send({ role: "admin" });

      expect(res.status).toBe(404);
    });
  });

  describe("user deletion", () => {
    it("deletes a user and cascades their jobs", async () => {
      const admin = await createUser({ role: "admin" });
      const targetUser = await createUser({ role: "user" });
      const cookie = getAuthCookie(admin);

      const job = new Job({
        userId: targetUser._id,
        repoUrl: "https://github.com/example/repo",
        instruction: "Fix bug",
        branchName: "feature/fix-bug",
        prTitle: "Fix bug in system",
      });
      await job.save();

      const res = await request(app)
        .delete(`/api/admin/users/${targetUser._id}`)
        .set("Cookie", [cookie]);

      expect(res.status).toBe(200);

      const deletedUser = await User.findById(targetUser._id);
      expect(deletedUser).toBeNull();

      const remainingJobs = await Job.find({ userId: targetUser._id });
      expect(remainingJobs.length).toBe(0);
    });

    it("blocks an admin from deleting themselves", async () => {
      const admin = await createUser({ role: "admin" });
      const cookie = getAuthCookie(admin);

      const res = await request(app)
        .delete(`/api/admin/users/${admin._id}`)
        .set("Cookie", [cookie]);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("SELF_DELETE_BLOCKED");

      const stillAdmin = await User.findById(admin._id);
      expect(stillAdmin).not.toBeNull();
    });

    it("404s when deleting a nonexistent user", async () => {
      const admin = await createUser({ role: "admin" });
      const cookie = getAuthCookie(admin);
      const fakeId = new mongoose.Types.ObjectId().toString();

      const res = await request(app)
        .delete(`/api/admin/users/${fakeId}`)
        .set("Cookie", [cookie]);

      expect(res.status).toBe(404);
    });
  });

  describe("job visibility (GET /api/jobs)", () => {
    it("scopes non-admins to their own jobs", async () => {
      const user1 = await createUser({ role: "user" });
      const user2 = await createUser({ role: "user" });

      await new Job({
        userId: user1._id,
        repoUrl: "https://github.com/u1/repo",
        instruction: "Task 1",
        branchName: "feature/task-1",
        prTitle: "PR Task 1",
      }).save();

      await new Job({
        userId: user2._id,
        repoUrl: "https://github.com/u2/repo",
        instruction: "Task 2",
        branchName: "feature/task-2",
        prTitle: "PR Task 2",
      }).save();

      const cookie1 = getAuthCookie(user1);
      const res = await request(app)
        .get("/api/jobs")
        .set("Cookie", [cookie1]);

      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].instruction).toBe("Task 1");
    });

    it("shows admins every job across users", async () => {
      const admin = await createUser({ role: "admin" });
      const user1 = await createUser({ role: "user" });

      await new Job({
        userId: admin._id,
        repoUrl: "https://github.com/admin/repo",
        instruction: "Admin task",
        branchName: "feature/admin-task",
        prTitle: "PR Admin Task",
      }).save();

      await new Job({
        userId: user1._id,
        repoUrl: "https://github.com/u1/repo",
        instruction: "User task",
        branchName: "feature/user-task",
        prTitle: "PR User Task",
      }).save();

      const cookie = getAuthCookie(admin);
      const res = await request(app)
        .get("/api/jobs")
        .set("Cookie", [cookie]);

      expect(res.status).toBe(200);
      expect(res.body.length).toBe(2);
    });

    it("lets an admin view any single job by id", async () => {
      const admin = await createUser({ role: "admin" });
      const user1 = await createUser({ role: "user" });

      const job = new Job({
        userId: user1._id,
        repoUrl: "https://github.com/u1/repo",
        instruction: "User task",
        branchName: "feature/user-task",
        prTitle: "PR User Task",
      });
      await job.save();

      const cookie = getAuthCookie(admin);
      const res = await request(app)
        .get(`/api/jobs/${job._id}`)
        .set("Cookie", [cookie]);

      expect(res.status).toBe(200);
      expect(res.body.instruction).toBe("User task");
    });
  });
});