import express from "express";
import mongoose from "mongoose";
import User from "../models/User.js";
import Job from "../models/Job.js";
import { protect, requireAdmin } from "../middleware/auth.js";
import { updateUserRoleSchema, validate } from "../middleware/validate.js";

const router = express.Router();

router.use(protect, requireAdmin);

// GET /api/admin/users
router.get("/users", async (req, res) => {
  try {
    const users = await User.find()
      .select("-password -githubToken -openaiKey")
      .sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: err.message, code: "INTERNAL_ERROR" });
  }
});

// PATCH /api/admin/users/:id/role
router.patch(
  "/users/:id/role",
  validate(updateUserRoleSchema),
  async (req, res) => {
    try {
      const { role } = req.body;
      const targetId = req.params.id;

      // Check ObjectId validity to return 404 on bad/non-existent IDs
      if (!mongoose.Types.ObjectId.isValid(targetId)) {
        return res
          .status(404)
          .json({ message: "User not found", code: "NOT_FOUND" });
      }

      // Block self-demotion
      if (String(req.user._id) === String(targetId) && role !== "admin") {
        return res.status(400).json({
          message: "You cannot remove your own admin role",
          code: "SELF_DEMOTE_BLOCKED",
        });
      }

      const user = await User.findByIdAndUpdate(
        targetId,
        { role },
        { new: true },
      ).select("-password -githubToken -openaiKey");

      if (!user) {
        return res
          .status(404)
          .json({ message: "User not found", code: "NOT_FOUND" });
      }

      res.json(user);
    } catch (err) {
      res.status(500).json({ message: err.message, code: "INTERNAL_ERROR" });
    }
  },
);

// DELETE /api/admin/users/:id
router.delete("/users/:id", async (req, res) => {
  try {
    const targetId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(targetId)) {
      return res
        .status(404)
        .json({ message: "User not found", code: "NOT_FOUND" });
    }

    if (String(req.user._id) === String(targetId)) {
      return res.status(400).json({
        message: "You cannot delete your own account",
        code: "SELF_DELETE_BLOCKED",
      });
    }

    const deleted = await User.findByIdAndDelete(targetId);
    if (!deleted) {
      return res
        .status(404)
        .json({ message: "User not found", code: "NOT_FOUND" });
    }

    await Job.deleteMany({ userId: targetId });

    res.json({ message: "User deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message, code: "INTERNAL_ERROR" });
  }
});

export default router;