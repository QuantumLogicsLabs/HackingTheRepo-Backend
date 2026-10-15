import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import DashboardPage from "../pages/DashboardPage";
import { AuthProvider } from "../context/AuthContext";
import { ThemeProvider } from "../context/ThemeContext";
import api, { TOKEN_KEY, USER_KEY } from "../utils/api";

vi.mock("../utils/api", async () => {
  const actual = await vi.importActual<typeof import("../utils/api")>("../utils/api");
  return {
    ...actual,
    default: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      defaults: { baseURL: "/api", headers: { common: {} } },
      interceptors: actual.default.interceptors,
    },
  };
});

vi.mock("../utils/metrics", () => ({ sendMetricEvent: vi.fn() }));

describe("DashboardPage", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(TOKEN_KEY, "jwt");
    localStorage.setItem(
      USER_KEY,
      JSON.stringify({ id: "1", username: "alice", email: "a@example.com" }),
    );
    vi.clearAllMocks();
    (api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === "/auth/me") {
        return Promise.resolve({
          data: { id: "1", username: "alice", email: "a@example.com" },
        });
      }
      return Promise.resolve({ data: [] });
    });
  });

  it("shows empty state", async () => {
    render(
      <ThemeProvider>
        <AuthProvider>
          <MemoryRouter>
            <DashboardPage />
          </MemoryRouter>
        </AuthProvider>
      </ThemeProvider>,
    );

    await waitFor(
      () => {
        expect(screen.getByText("No jobs yet")).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it("renders job list", async () => {
    (api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === "/auth/me") {
        return Promise.resolve({
          data: { id: "1", username: "alice", email: "a@example.com" },
        });
      }
      return Promise.resolve({
        data: [
          {
            _id: "j1",
            repoUrl: "https://github.com/a/b",
            instruction: "add tests",
            branchName: "repomind/x",
            status: "completed",
            createdAt: new Date().toISOString(),
          },
        ],
      });
    });

    render(
      <ThemeProvider>
        <AuthProvider>
          <MemoryRouter>
            <DashboardPage />
          </MemoryRouter>
        </AuthProvider>
      </ThemeProvider>,
    );

    await waitFor(
      () => {
        expect(screen.getByText(/add tests/i)).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });
});
