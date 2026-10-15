import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
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
  vi.restoreAllMocks();
});

describe("auth", () => {
  it("signs up and returns token + user", async () => {
    const res = await agent(app).post("/api/auth/signup").send({
      username: "alice",
      email: "alice@example.com",
      password: "password123",
    });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user).toMatchObject({
      username: "alice",
      email: "alice@example.com",
    });
  });

  it("rejects duplicate signup", async () => {
    await agent(app).post("/api/auth/signup").send({
      username: "alice",
      email: "alice@example.com",
      password: "password123",
    });

    const res = await agent(app).post("/api/auth/signup").send({
      username: "alice",
      email: "alice@example.com",
      password: "password123",
    });

    expect(res.status).toBe(400);
  });

  it("logs in with valid credentials", async () => {
    await agent(app).post("/api/auth/signup").send({
      username: "bob",
      email: "bob@example.com",
      password: "password123",
    });

    const res = await agent(app).post("/api/auth/login").send({
      email: "bob@example.com",
      password: "password123",
    });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it("rejects bad password", async () => {
    await agent(app).post("/api/auth/signup").send({
      username: "bob",
      email: "bob@example.com",
      password: "password123",
    });

    const res = await agent(app).post("/api/auth/login").send({
      email: "bob@example.com",
      password: "wrong",
    });

    expect(res.status).toBe(401);
  });

  it("returns /me with valid bearer", async () => {
    const { token, user } = await createUserAndToken({
      username: "carol",
      email: "carol@example.com",
    });

    const res = await agent(app)
      .get("/api/auth/me")
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.email).toBe(user.email);
  });

  it("rejects /me without token", async () => {
    const res = await agent(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("logout returns 204", async () => {
    const res = await agent(app).post("/api/auth/logout");
    expect(res.status).toBe(204);
  });
});

describe("github oauth start", () => {
  const original = process.env.GITHUB_CLIENT_ID;

  afterAll(() => {
    if (original === undefined) delete process.env.GITHUB_CLIENT_ID;
    else process.env.GITHUB_CLIENT_ID = original;
  });

  it("returns OAUTH_DISABLED when no client id is configured", async () => {
    delete process.env.GITHUB_CLIENT_ID;
    const res = await agent(app).get("/api/auth/github");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("OAUTH_DISABLED");
  });

  it("echoes the state sent by the frontend so the browser check passes", async () => {
    process.env.GITHUB_CLIENT_ID = "test-client-id";
    const state = "3217dee6-174f-47a9-b094-aef012345678";
    const res = await agent(app)
      .get("/api/auth/github")
      .query({ redirect_uri: "http://localhost:3000/auth/github/callback", state });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("state")).toBe(state);
  });

  it("generates a state when the frontend sends none or a malformed one", async () => {
    process.env.GITHUB_CLIENT_ID = "test-client-id";
    const res = await agent(app).get("/api/auth/github").query({ state: "bad state!" });

    expect(res.status).toBe(302);
    const state = new URL(res.headers.location).searchParams.get("state");
    expect(state).toMatch(/^[a-f0-9]{32}$/);
  });
});
