import express from "express";
import jwt from "jsonwebtoken";
import axios from "axios";
import crypto from "crypto";
import User from "../models/User.js";
import { protect } from "../middleware/auth.js";
import {
  githubCallbackSchema,
  loginSchema,
  signupSchema,
  validate,
} from "../middleware/validate.js";
import { encryptSecret } from "../utils/crypto.js";

const router = express.Router();

const getJwtSecret = () => {
  if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is required in production");
  }
  return process.env.JWT_SECRET || "secret";
};

const signToken = (id) =>
  jwt.sign({ id }, getJwtSecret(), { expiresIn: "7d" });

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
      return res
        .status(400)
        .json({ message: "Username or email already taken", code: "USER_EXISTS" });
    }

    const user = await User.create({ username, email, password });
    const token = signToken(user._id);

    res.status(201).json({
      token,
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
    res.json({
      token,
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

// POST /api/auth/logout — JWT is client-cleared; route exists for API symmetry
router.post("/logout", (_req, res) => {
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
    req.query.redirect_uri ||
    process.env.GITHUB_OAUTH_REDIRECT_URI ||
    "http://localhost:3000/auth/github/callback";
  const state = crypto.randomBytes(16).toString("hex");
  oauthStates.set(state, { redirectUri, createdAt: Date.now() });

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "read:user user:email repo");
  url.searchParams.set("state", state);

  res.redirect(url.toString());
});

// POST /api/auth/github/callback
router.post(
  "/github/callback",
  validate(githubCallbackSchema),
  async (req, res) => {
    try {
      const { code, state, redirectUri } = req.body;
      const clientId = process.env.GITHUB_CLIENT_ID;
      const clientSecret = process.env.GITHUB_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        return res.status(503).json({
          message: "GitHub OAuth is not configured",
          code: "OAUTH_DISABLED",
        });
      }

      if (state && oauthStates.has(state)) {
        oauthStates.delete(state);
      }

      const tokenRes = await axios.post(
        "https://github.com/login/oauth/access_token",
        {
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        },
        { headers: { Accept: "application/json" } },
      );

      const accessToken = tokenRes.data.access_token;
      if (!accessToken) {
        return res.status(401).json({
          message: "GitHub OAuth failed",
          code: "OAUTH_FAILED",
        });
      }

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
      res.json({
        token,
        user: toAuthUser(user),
        githubUsername,
        githubToken: accessToken,
      });
    } catch (err) {
      res.status(500).json({
        message: err.response?.data?.message || err.message,
        code: "OAUTH_ERROR",
      });
    }
  },
);

export default router;
