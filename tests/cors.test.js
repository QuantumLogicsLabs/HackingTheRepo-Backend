import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../index.js";

process.env.VITEST = "true";
process.env.FRONTEND_ORIGIN = "http://localhost:3000";

describe("cors", () => {
  it("allows configured origin", async () => {
    const res = await request(app)
      .get("/api/health")
      .set("Origin", "http://localhost:3000");

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "http://localhost:3000",
    );
  });

  it("does not reflect disallowed origin", async () => {
    const res = await request(app)
      .get("/api/health")
      .set("Origin", "http://evil.example");

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).not.toBe(
      "http://evil.example",
    );
  });
});
