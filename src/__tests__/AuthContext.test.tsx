import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext";
import { ThemeProvider } from "../context/ThemeContext";
import { LoginPage } from "../pages/AuthPages";
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

vi.mock("../utils/metrics", () => ({
  sendMetricEvent: vi.fn(),
}));

function renderLogin() {
  return render(
    <ThemeProvider>
      <AuthProvider>
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>
      </AuthProvider>
    </ThemeProvider>,
  );
}

describe("AuthContext login", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    (api.get as ReturnType<typeof vi.fn>).mockRejectedValue({
      response: { status: 401 },
    });
  });

  it("persists token and user on login", async () => {
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        token: "jwt-123",
        user: { id: "u1", username: "alice", email: "alice@example.com" },
      },
    });

    renderLogin();

    await userEvent.type(screen.getByPlaceholderText("you@example.com"), "alice@example.com");
    await userEvent.type(screen.getByPlaceholderText("••••••••"), "password123");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(localStorage.getItem(TOKEN_KEY)).toBe("jwt-123");
      expect(JSON.parse(localStorage.getItem(USER_KEY) || "null")).toMatchObject({
        email: "alice@example.com",
      });
    });
  });

  it("does not use offline fallback on 401", async () => {
    (api.post as ReturnType<typeof vi.fn>).mockRejectedValue({
      response: { status: 401, data: { message: "Invalid credentials" } },
    });

    renderLogin();

    await userEvent.type(screen.getByPlaceholderText("you@example.com"), "alice@example.com");
    await userEvent.type(screen.getByPlaceholderText("••••••••"), "bad");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText(/invalid credentials/i)).toBeInTheDocument();
    });
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});
