import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import app from "../index.js";
import {
  connectTestDb,
  clearDb,
  disconnectTestDb,
  createUserAndToken,
  authHeader,
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

describe("settings", () => {
  it("requires auth", async () => {
    const res = await agent(app).get("/api/settings");
    expect(res.status).toBe(401);
  });

  it("saves and masks secrets", async () => {
    const { token } = await createUserAndToken({
      stripSecrets: true,
      username: "settingsuser",
      email: "settings@example.com",
    });

    const put = await agent(app)
      .put("/api/settings")
      .set(authHeader(token))
      .send({
        githubUsername: "octocat",
        githubToken: "ghp_abcdef123456",
        groqKey: "gsk_groqabcdef",
      });

    expect(put.status).toBe(200);

    const get = await agent(app)
      .get("/api/settings")
      .set(authHeader(token));

    expect(get.status).toBe(200);
    expect(get.body.hasGithubToken).toBe(true);
    expect(get.body.hasGroqKey).toBe(true);
    expect(get.body.githubToken).toContain("••••");
    expect(get.body.groqKey).toContain("••••");
  });

  it("rejects empty update", async () => {
    const { token } = await createUserAndToken({
      username: "emptyupd",
      email: "emptyupd@example.com",
    });

    const res = await agent(app)
      .put("/api/settings")
      .set(authHeader(token))
      .send({});

    expect(res.status).toBe(400);
  });
});
