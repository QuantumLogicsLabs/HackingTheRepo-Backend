import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import axios from "axios";
import app from "../index.js";
import Job from "../models/Job.js";
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
process.env.REPOMIND_API_URL = "http://repomind.test";

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

describe("jobs", () => {
  it("requires auth", async () => {
    const res = await agent(app).post("/api/jobs").send({
      repoUrl: "https://github.com/a/b",
      instruction: "do stuff",
    });
    expect(res.status).toBe(401);
  });

  it("requires settings keys", async () => {
    const { token } = await createUserAndToken({
      stripSecrets: true,
      username: "nosettings",
      email: "nosettings@example.com",
    });

    const res = await agent(app)
      .post("/api/jobs")
      .set(authHeader(token))
      .send({
        repoUrl: "https://github.com/a/b",
        instruction: "do stuff",
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SETTINGS_REQUIRED");
  });

  it("creates job and dispatches to RepoMind", async () => {
    vi.spyOn(axios, "post").mockResolvedValue({ data: { job_id: "rm-1" } });
    const { token } = await createUserAndToken({
      username: "jobber",
      email: "jobber@example.com",
    });

    const res = await agent(app)
      .post("/api/jobs")
      .set(authHeader(token))
      .send({
        repoUrl: "https://github.com/a/b",
        instruction: "add tests",
        previewBeforePush: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("running");
    expect(res.body.repomindJobId).toBe("rm-1");
    expect(res.body.previewBeforePush).toBe(true);
    expect(axios.post).toHaveBeenCalledWith(
      "http://repomind.test/run",
      expect.objectContaining({
        create_pr: false,
        repo_url: "https://github.com/a/b",
      }),
    );
  });

  it("keeps queued when RepoMind is down", async () => {
    vi.spyOn(axios, "post").mockRejectedValue(new Error("ECONNREFUSED"));
    const { token } = await createUserAndToken({
      username: "queued",
      email: "queued@example.com",
    });

    const res = await agent(app)
      .post("/api/jobs")
      .set(authHeader(token))
      .send({
        repoUrl: "https://github.com/a/b",
        instruction: "add tests",
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("queued");
    expect(res.body.errorMessage).toMatch(/unreachable/i);
  });

  it("scopes get to owner", async () => {
    const owner = await createUserAndToken({
      username: "owner",
      email: "owner@example.com",
    });
    const other = await createUserAndToken({
      username: "other",
      email: "other@example.com",
    });

    const job = await Job.create({
      userId: owner.user._id,
      repoUrl: "https://github.com/a/b",
      instruction: "x",
      branchName: "repomind/x",
      prTitle: "x",
      status: "queued",
    });

    const res = await agent(app)
      .get(`/api/jobs/${job._id}`)
      .set(authHeader(other.token));

    expect(res.status).toBe(404);
  });

  it("polls status and maps completed PR", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({
      data: {
        status: "completed",
        pr_url: "https://github.com/a/b/pull/12",
        diff_summary: "Modified 1 file(s)",
      },
    });

    const { token, user } = await createUserAndToken({
      username: "poller",
      email: "poller@example.com",
    });

    const job = await Job.create({
      userId: user._id,
      repoUrl: "https://github.com/a/b",
      instruction: "x",
      branchName: "repomind/x",
      prTitle: "x",
      status: "running",
      repomindJobId: "rm-99",
      startedAt: new Date(),
    });

    const res = await agent(app)
      .get(`/api/jobs/${job._id}/status`)
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(res.body.prUrl).toBe("https://github.com/a/b/pull/12");
    expect(res.body.diffSummary).toBe("Modified 1 file(s)");
    expect(res.body.finishedAt).toBeTruthy();
  });

  it("open-pr succeeds for completed preview job", async () => {
    vi.spyOn(axios, "post").mockResolvedValue({
      data: { pr_url: "https://github.com/a/b/pull/42" },
    });

    const { token, user } = await createUserAndToken({
      username: "opener",
      email: "opener@example.com",
    });

    const job = await Job.create({
      userId: user._id,
      repoUrl: "https://github.com/a/b",
      instruction: "x",
      branchName: "repomind/x",
      prTitle: "x",
      status: "completed",
      previewBeforePush: true,
      repomindJobId: "rm-open",
      diffSummary: "diff",
    });

    const res = await agent(app)
      .post(`/api/jobs/${job._id}/open-pr`)
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.prUrl).toBe("https://github.com/a/b/pull/42");
  });

  it("open-pr rejects when PR already exists", async () => {
    const { token, user } = await createUserAndToken({
      username: "haspr",
      email: "haspr@example.com",
    });

    const job = await Job.create({
      userId: user._id,
      repoUrl: "https://github.com/a/b",
      instruction: "x",
      branchName: "repomind/x",
      prTitle: "x",
      status: "completed",
      prUrl: "https://github.com/a/b/pull/1",
      repomindJobId: "rm-1",
    });

    const res = await agent(app)
      .post(`/api/jobs/${job._id}/open-pr`)
      .set(authHeader(token));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PR_EXISTS");
  });

  it("refines and sets running", async () => {
    vi.spyOn(axios, "post").mockResolvedValue({
      data: { job_id: "rm-1", status: "queued" },
    });
    const { token, user } = await createUserAndToken({
      username: "refiner",
      email: "refiner@example.com",
    });

    const job = await Job.create({
      userId: user._id,
      repoUrl: "https://github.com/a/b",
      instruction: "x",
      branchName: "repomind/x",
      prTitle: "x",
      status: "completed",
      repomindJobId: "rm-1",
    });

    const res = await agent(app)
      .post(`/api/jobs/${job._id}/refine`)
      .set(authHeader(token))
      .send({ instruction: "also add types" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("running");
    expect(res.body.refinements).toHaveLength(1);
  });

  it("deletes owner job", async () => {
    const { token, user } = await createUserAndToken({
      username: "deleter",
      email: "deleter@example.com",
    });

    const job = await Job.create({
      userId: user._id,
      repoUrl: "https://github.com/a/b",
      instruction: "x",
      branchName: "repomind/x",
      prTitle: "x",
    });

    const res = await agent(app)
      .delete(`/api/jobs/${job._id}`)
      .set(authHeader(token));

    expect(res.status).toBe(200);
  });
});
