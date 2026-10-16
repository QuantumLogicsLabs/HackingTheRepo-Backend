import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../index.js";

describe("GET /api/health", () => {
  it("returns ok status", async () => {
    const res = await request(app).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok" });
    expect(typeof res.body.bot).toBe("string");
  });
});
