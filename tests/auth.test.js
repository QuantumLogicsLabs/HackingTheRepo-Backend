import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import app from "../index.js";
import {
  connectTestDb,
  clearDb,
  disconnectTestDb,
  agent,
} from "./helpers.js";

process.env.VITEST = "true";
process.env.JWT_SECRET = process.env.JWT_SECRET || "ci-test-secret";

const SESSION_COOKIE = "rm_session";

function getSessionCookie(res) {
  const cookies = res.headers["set-cookie"];
  if (!cookies) return undefined;
  return cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
}

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
  it("signs up and sets an httpOnly session cookie + returns user", async () => {
    const res = await agent(app).post("/api/auth/signup").send({
      username: "alice",
      email: "alice@example.com",
      password: "password123",
    });

    expect(res.status).toBe(201);

    const sessionCookie = getSessionCookie(res);
    expect(sessionCookie).toBeTruthy();
    expect(sessionCookie).toContain("HttpOnly");

    expect(res.body.user).toMatchObject({
      username: "alice",
      email: "alice@example.com",
    });
    expect(res.body.token).toBeUndefined();
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

  it("logs in with valid credentials and sets a session cookie", async () => {
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

    const sessionCookie = getSessionCookie(res);
    expect(sessionCookie).toBeTruthy();
    expect(sessionCookie).toContain("HttpOnly");
    expect(res.body.token).toBeUndefined();
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

  it("returns /me when the session cookie is present", async () => {
    const client = agent(app);

    await client.post("/api/auth/signup").send({
      username: "carol",
      email: "carol@example.com",
      password: "password123",
    });

    const res = await client.get("/api/auth/me");

    expect(res.status).toBe(200);
    expect(res.body.email).toBe("carol@example.com");
  });

  it("rejects /me without a session cookie", async () => {
    const res = await agent(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("logout returns 204 and clears the session cookie", async () => {
    const client = agent(app);

    await client.post("/api/auth/signup").send({
      username: "dave",
      email: "dave@example.com",
      password: "password123",
    });

    const res = await client.post("/api/auth/logout");
    expect(res.status).toBe(204);

    const clearedCookie = getSessionCookie(res);
    expect(clearedCookie).toBeTruthy();
    expect(clearedCookie).toMatch(/Expires=|Max-Age=0/);
  });
});