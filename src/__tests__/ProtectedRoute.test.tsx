import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "../context/AuthContext";
import { ThemeProvider } from "../context/ThemeContext";
import api, { TOKEN_KEY, USER_KEY } from "../utils/api";
import type { ReactElement } from "react";

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

function PrivateRoute({ children }: { children: ReactElement }) {
  const { user, loading } = useAuth();
  if (loading) return <div>Loading…</div>;
  return user ? children : <div>Redirected to login</div>;
}

function Dashboard() {
  return <div>Dashboard content</div>;
}

describe("protected routing", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("redirects unauthenticated users", async () => {
    (api.get as ReturnType<typeof vi.fn>).mockRejectedValue({
      response: { status: 401 },
    });

    render(
      <ThemeProvider>
        <AuthProvider>
          <MemoryRouter>
            <PrivateRoute>
              <Dashboard />
            </PrivateRoute>
          </MemoryRouter>
        </AuthProvider>
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText(/redirected to login/i)).toBeInTheDocument();
    });
  });

  it("allows authenticated users", async () => {
    localStorage.setItem(TOKEN_KEY, "jwt");
    localStorage.setItem(
      USER_KEY,
      JSON.stringify({ id: "1", username: "a", email: "a@example.com" }),
    );
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: "1", username: "a", email: "a@example.com" },
    });

    render(
      <ThemeProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={["/dashboard"]}>
            <Routes>
              <Route
                path="/dashboard"
                element={
                  <PrivateRoute>
                    <Dashboard />
                  </PrivateRoute>
                }
              />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText(/dashboard content/i)).toBeInTheDocument();
    });
  });
});
