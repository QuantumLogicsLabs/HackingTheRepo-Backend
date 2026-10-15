import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import AnalyticsPage from "../pages/AnalyticsPage";
import api from "../utils/api";

vi.mock("../utils/api", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    defaults: { baseURL: "/api", headers: { common: {} } },
  },
}));

vi.mock("../utils/metrics", () => ({ sendMetricEvent: vi.fn() }));

describe("AnalyticsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds charts from jobs with timestamps without crashing", async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        {
          _id: "j1",
          repoUrl: "https://github.com/a/b",
          instruction: "x",
          branchName: "repomind/x",
          status: "completed",
          createdAt: "2026-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:05:00.000Z",
          updatedAt: "2026-01-01T00:05:00.000Z",
        },
      ],
    });

    render(<AnalyticsPage />);

    await waitFor(
      () => {
        expect(screen.getByText(/analytics/i)).toBeInTheDocument();
        expect(screen.getByText(/success rate/i)).toBeInTheDocument();
        expect(screen.getByText(/job duration/i)).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });
});
