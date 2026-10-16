import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import app from "../index.js";
import {
  connectTestDb,
  clearDb,
  disconnectTestDb,
  createUserAndToken,
  agent,
} from "./helpers.js";

process.env.VITEST = "true";
process.env.JWT_SECRET = process.env.JWT_SECRET || "ci-test-secret";

beforeAll(async () => {
  await connectTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await clearDb();
});

describe("auth middleware", () => {
  it("rejects missing header", async () => {
    const res = await agent(app).get("/api/settings");
    expect(res.status).toBe(401);
  });

  it("rejects malformed bearer", async () => {
    const res = await agent(app)
      .get("/api/settings")
      .set("Authorization", "Token abc");
    expect(res.status).toBe(401);
  });

  it("rejects forged jwt", async () => {
    const token = jwt.sign({ id: "507f1f77bcf86cd799439011" }, "wrong-secret");
    const res = await agent(app)
      .get("/api/settings")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it("rejects expired jwt", async () => {
    const { user } = await createUserAndToken({
      username: "expired",
      email: "expired@example.com",
    });
    const token = jwt.sign(
      { id: user._id },
      process.env.JWT_SECRET || "secret",
      { expiresIn: -10 },
    );
    const res = await agent(app)
      .get("/api/settings")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});
