import express from "express";
import jwt from "jsonwebtoken";
import axios from "axios";
import crypto from "crypto";
import User from "../models/User.js";
import { protect } from "../middleware/auth.js";
import {
  loginSchema,
  signupSchema,
  validate,
} from "../middleware/validate.js";
import { encryptSecret } from "../utils/crypto.js";

const COOKIE_NAME = "rm_session";

const cookieOptions = () => {
  const isProd =
    process.env.NODE_ENV === "production" && process.env.VITEST !== "true";

  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "strict" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  };
};

const router = express.Router();

const getJwtSecret = () => {
  if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is required in production");
  }
  return process.env.JWT_SECRET || "secret";
};

const signToken = (id) => jwt.sign({ id }, getJwtSecret(), { expiresIn: "7d" });

const oauthStates = new Map();

function toAuthUser(user) {
  return {
    id: user._id,
    username: user.username,
    email: user.email,
    githubUsername: user.githubUsername,
    totalJobs: user.totalJobs,
    successfulPRs: user.successfulPRs,
  };
}

// POST /api/auth/signup
router.post("/signup", validate(signupSchema), async (req, res) => {
  try {
    const { username, email, password } = req.body;

    const exists = await User.findOne({ $or: [{ email }, { username }] });
    if (exists) {
      return res.status(400).json({
        message: "Username or email already taken",
        code: "USER_EXISTS",
      });
    }

    const user = await User.create({ username, email, password });
    const token = signToken(user._id);

    res.cookie(COOKIE_NAME, token, cookieOptions());
    res.status(201).json({
      user: toAuthUser(user),
    });
  } catch (err) {
    res.status(500).json({ message: err.message, code: "INTERNAL_ERROR" });
  }
});

// POST /api/auth/login
router.post("/login", validate(loginSchema), async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await user.comparePassword(password))) {
      return res
        .status(401)
        .json({ message: "Invalid credentials", code: "INVALID_CREDENTIALS" });
    }

    const token = signToken(user._id);
    res.cookie(COOKIE_NAME, token, cookieOptions());
    res.json({
      user: toAuthUser(user),
    });
  } catch (err) {
    res.status(500).json({ message: err.message, code: "INTERNAL_ERROR" });
  }
});

// GET /api/auth/me
router.get("/me", protect, async (req, res) => {
  res.json(toAuthUser(req.user));
});

// POST /api/auth/logout — clears the httpOnly session cookie
router.post("/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
  res.status(204).send();
});

// GET /api/auth/github — start OAuth
router.get("/github", (req, res) => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return res
      .status(503)
      .json({ message: "GitHub OAuth is not configured", code: "OAUTH_DISABLED" });
  }

  const redirectUri =
    process.env.GITHUB_OAUTH_REDIRECT_URI ||
    `${process.env.BACKEND_ORIGIN || "http://localhost:5000"}/api/auth/github/callback`;
  const state = crypto.randomBytes(16).toString("hex");
  oauthStates.set(state, { redirectUri, createdAt: Date.now() });

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "read:user user:email repo");
  url.searchParams.set("state", state);

  res.redirect(url.toString());
});

// GET /api/auth/github/callback — GitHub redirects the browser here directly
router.get("/github/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    const stored = oauthStates.get(state);
    if (!stored) {
      return res.redirect(
        `${process.env.FRONTEND_ORIGIN?.split(",")[0]}/login?error=invalid_state`,
      );
    }
    oauthStates.delete(state);

    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return res.redirect(
        `${process.env.FRONTEND_ORIGIN?.split(",")[0]}/login?error=oauth_disabled`,
      );
    }

    const tokenRes = await axios.post(
      "https://github.com/login/oauth/access_token",
      {
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: stored.redirectUri,
      },
      { headers: { Accept: "application/json" } },
    );
    const accessToken = tokenRes.data.access_token;
    if (!accessToken) throw new Error("GitHub OAuth failed");

    const [profileRes, emailsRes] = await Promise.all([
      axios.get("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
      axios.get("https://api.github.com/user/emails", {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    ]);

    const githubUsername = profileRes.data.login;
    const primaryEmail =
      emailsRes.data.find((e) => e.primary)?.email ||
      emailsRes.data[0]?.email ||
      `${githubUsername}@users.noreply.github.com`;

    let user = await User.findOne({
      $or: [{ email: primaryEmail }, { githubUsername }],
    });

    if (!user) {
      user = await User.create({
        username: githubUsername,
        email: primaryEmail,
        password: crypto.randomBytes(24).toString("hex"),
        githubUsername,
        githubToken: encryptSecret(accessToken),
      });
    } else {
      user.githubUsername = githubUsername;
      user.githubToken = encryptSecret(accessToken);
      await user.save();
    }

    const token = signToken(user._id);
    res.cookie(COOKIE_NAME, token, cookieOptions());
    res.redirect(`${process.env.FRONTEND_ORIGIN?.split(",")[0]}/dashboard`);
  } catch (err) {
    res.redirect(
      `${process.env.FRONTEND_ORIGIN?.split(",")[0]}/login?error=oauth_failed`,
    );
  }
});

export default router;
