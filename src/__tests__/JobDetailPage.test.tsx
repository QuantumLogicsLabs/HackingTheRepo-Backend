import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import JobDetailPage from "../pages/JobDetailPage";
import api from "../utils/api";

vi.mock("../utils/api", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    defaults: { baseURL: "/api", headers: { common: {} } },
  },
}));

vi.mock("../utils/metrics", () => ({ sendMetricEvent: vi.fn() }));

const completedPreviewJob = {
  _id: "job1",
  repoUrl: "https://github.com/a/b",
  instruction: "add tests",
  branchName: "repomind/add-tests",
  prTitle: "add tests",
  status: "completed",
  createdAt: new Date().toISOString(),
  diffSummary: "Modified 2 file(s)",
  prUrl: null,
};

describe("JobDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("shows open-pr when diff exists without PR", async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: completedPreviewJob,
    });

    render(
      <MemoryRouter initialEntries={["/jobs/job1"]}>
        <Routes>
          <Route path="/jobs/:id" element={<JobDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /open pr now/i })).toBeInTheDocument();
    });
  });

  it("shows PR link when prUrl set", async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        ...completedPreviewJob,
        prUrl: "https://github.com/a/b/pull/9",
      },
    });

    render(
      <MemoryRouter initialEntries={["/jobs/job1"]}>
        <Routes>
          <Route path="/jobs/:id" element={<JobDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        screen.getByText(/https:\/\/github\.com\/a\/b\/pull\/9/i),
      ).toBeInTheDocument();
    });
  });

  it("posts refine instruction", async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: completedPreviewJob,
    });
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { ...completedPreviewJob, status: "running" },
    });

    render(
      <MemoryRouter initialEntries={["/jobs/job1"]}>
        <Routes>
          <Route path="/jobs/:id" element={<JobDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/refine pr/i)).toBeInTheDocument();
    });

    const refineInput = screen.getByPlaceholderText(
      /also add JSDoc comments/i,
    );
    await userEvent.type(refineInput, "also add types");
    await userEvent.click(
      screen.getByRole("button", { name: /send refinement/i }),
    );

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith("/jobs/job1/refine", {
        instruction: "also add types",
      });
    });
  });

  it("deletes job after confirm", async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: completedPreviewJob,
    });
    (api.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} });

    render(
      <MemoryRouter initialEntries={["/jobs/job1"]}>
        <Routes>
          <Route path="/jobs/:id" element={<JobDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /delete/i })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: /delete/i }));
    await waitFor(() => {
      expect(api.delete).toHaveBeenCalledWith("/jobs/job1");
    });
  });
});
