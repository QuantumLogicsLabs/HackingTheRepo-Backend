import express from "express";
import axios from "axios";
import { protect } from "../middleware/auth.js";
import { assistantSchema, validate } from "../middleware/validate.js";
import User from "../models/User.js";
import { decryptSecret } from "../utils/crypto.js";

const router = express.Router();

router.post(
  "/improve",
  protect,
  validate(assistantSchema),
  async (req, res) => {
    try {
      const user = await User.findById(req.user._id);
      const userKey = decryptSecret(user?.openaiKey);
      const apiKey = userKey || process.env.OPENAI_API_KEY;

      if (!apiKey) {
        return res.status(502).json({
          message: "No OpenAI API key configured in settings or server env",
          code: "LLM_UNAVAILABLE",
        });
      }

      const { instruction } = req.body;
      const response = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          // FIX: llama-3.3-70b-versatile was decommissioned by Groq on
          // 2026-08-16. openai/gpt-oss-120b is Groq's recommended replacement.
          model: process.env.OPENAI_MODEL || "openai/gpt-oss-120b",
          messages: [
            {
              role: "system",
              content:
                "Rewrite the user's coding instruction to be clearer, more actionable, and specific about files/behavior. Return only the improved instruction text.",
            },
            { role: "user", content: instruction },
          ],
          temperature: 0.3,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 30000,
        },
      );

      const improved =
        response.data?.choices?.[0]?.message?.content?.trim() || "";
      if (!improved) {
        return res.status(502).json({
          message: "Assistant returned an empty response",
          code: "LLM_EMPTY",
        });
      }

      res.json({ improvedInstruction: improved });
    } catch (err) {
      res.status(502).json({
        message:
          err.response?.data?.error?.message ||
          err.message ||
          "Assistant failed",
        code: "LLM_FAILED",
      });
    }
  },
);

export default router;