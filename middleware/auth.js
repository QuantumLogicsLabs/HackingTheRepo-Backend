import jwt from "jsonwebtoken";
import User from "../models/User.js";

const getJwtSecret = () => process.env.JWT_SECRET || "secret";

export const protect = async (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Not authorized", code: "UNAUTHORIZED" });
  }
  try {
    const token = auth.split(" ")[1];
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
