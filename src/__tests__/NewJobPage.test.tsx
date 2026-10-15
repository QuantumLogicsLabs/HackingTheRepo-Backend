import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import NewJobPage from "../pages/NewJobPage";
import api from "../utils/api";

const navigate = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return {
    ...actual,
    useNavigate: () => navigate,
  };
});

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

describe("NewJobPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts job with previewBeforePush", async () => {
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { _id: "job1" },
    });

    render(
      <MemoryRouter>
        <NewJobPage />
      </MemoryRouter>,
    );

    await userEvent.type(
      screen.getByPlaceholderText("https://github.com/owner/repo"),
      "https://github.com/a/b",
    );
    await userEvent.type(
      screen.getByPlaceholderText(
        "Describe the code change you want in plain English...",
      ),
      "Add unit tests",
    );

    await userEvent.click(
      screen.getByLabelText(/review the ai-generated diff/i),
    );

    await userEvent.click(
      screen.getByRole("button", { name: /create preview job/i }),
    );

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith(
        "/jobs",
        expect.objectContaining({
          repoUrl: "https://github.com/a/b",
          instruction: "Add unit tests",
          previewBeforePush: true,
        }),
      );
      expect(navigate).toHaveBeenCalledWith("/jobs/job1");
    });
  });

  it("shows assistant error instead of silent local rewrite", async () => {
    (api.post as ReturnType<typeof vi.fn>).mockRejectedValue({
      response: { data: { message: "No Groq API key configured" } },
    });

    render(
      <MemoryRouter>
        <NewJobPage />
      </MemoryRouter>,
    );

    await userEvent.type(
      screen.getByPlaceholderText(
        "Describe the code change you want in plain English...",
      ),
      "Add unit tests",
    );
    await userEvent.click(screen.getByRole("button", { name: /^ai$/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/no groq api key configured/i),
      ).toBeInTheDocument();
    });
  });
});
