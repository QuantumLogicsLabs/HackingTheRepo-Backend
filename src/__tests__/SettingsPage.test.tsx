import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import SettingsPage from "../pages/SettingsPage";
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

describe("SettingsPage", () => {
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
      return Promise.resolve({
        data: {
          githubUsername: "octocat",
          githubToken: "••••1234",
          groqKey: "••••abcd",
          hasGithubToken: true,
          hasGroqKey: true,
        },
      });
    });
  });

  it("loads masked settings and saves", async () => {
    (api.put as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { message: "Settings updated" },
    });

    render(
      <ThemeProvider>
        <AuthProvider>
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        </AuthProvider>
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue("octocat")).toBeInTheDocument();
    });

    await userEvent.type(
      screen.getByPlaceholderText(/enter new token to replace|ghp_/i),
      "ghp_newtoken",
    );
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(api.put).toHaveBeenCalled();
    });
  });
});
