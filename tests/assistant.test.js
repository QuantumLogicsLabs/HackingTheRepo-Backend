import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import axios from "axios";
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

describe("assistant", () => {
  it("requires auth", async () => {
    const res = await agent(app)
      .post("/api/assistant/improve")
      .send({ instruction: "add tests" });
    expect(res.status).toBe(401);
  });

  it("rejects empty instruction", async () => {
    const { token } = await createUserAndToken({
      username: "assist1",
      email: "assist1@example.com",
    });

    const res = await agent(app)
      .post("/api/assistant/improve")
      .set(authHeader(token))
      .send({ instruction: "" });

    expect(res.status).toBe(400);
  });

  it("returns improved instruction", async () => {
    vi.spyOn(axios, "post").mockResolvedValue({
      data: {
        choices: [{ message: { content: "Add unit tests for utils/" } }],
      },
    });

    const { token } = await createUserAndToken({
      username: "assist2",
      email: "assist2@example.com",
    });

    const res = await agent(app)
      .post("/api/assistant/improve")
      .set(authHeader(token))
      .send({ instruction: "add tests" });

    expect(res.status).toBe(200);
    expect(res.body.improvedInstruction).toBe("Add unit tests for utils/");
  });

  it("returns 502 when LLM fails", async () => {
    vi.spyOn(axios, "post").mockRejectedValue(new Error("groq down"));

    const { token } = await createUserAndToken({
      username: "assist3",
      email: "assist3@example.com",
    });

    const res = await agent(app)
      .post("/api/assistant/improve")
      .set(authHeader(token))
      .send({ instruction: "add tests" });

    expect(res.status).toBe(502);
  });
});
