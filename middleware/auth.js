import jwt from "jsonwebtoken";
import User from "../models/User.js";

const getJwtSecret = () => process.env.JWT_SECRET || "secret";
const SESSION_COOKIE = "rm_session";

export const protect = async (req, res, next) => {
  let token;

  // Prefer the session cookie
  if (req.cookies && req.cookies[SESSION_COOKIE]) {
    token = req.cookies[SESSION_COOKIE];
  } else {
    // Fallback: Authorization header
    const auth = req.headers.authorization;
    if (auth && auth.startsWith("Bearer ")) {
      token = auth.split(" ")[1];
    }
  }

  if (!token) {
    return res.status(401).json({ message: "Not authorized", code: "UNAUTHORIZED" });
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret());
    req.user = await User.findById(decoded.id).select("-password");
    if (!req.user) {
      return res.status(401).json({ message: "User not found", code: "UNAUTHORIZED" });
    }
    next();
  } catch {
    res.status(401).json({ message: "Token invalid", code: "UNAUTHORIZED" });
  }
};