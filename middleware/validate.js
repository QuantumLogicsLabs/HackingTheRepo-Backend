import { z } from "zod";

export const signupSchema = z.object({
  username: z.string().trim().min(2).max(64),
  email: z.string().trim().email(),
  password: z.string().min(6).max(128),
});

export const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export const settingsSchema = z.object({
  githubUsername: z.string().trim().max(128).optional(),
  githubToken: z.string().max(512).optional(),
  groqKey: z.string().max(512).optional(),
});

export const createJobSchema = z.object({
  repoUrl: z.string().url(),
  instruction: z.string().trim().min(1),
  branchName: z.string().trim().max(120).optional(),
  prTitle: z.string().trim().max(200).optional(),
  previewBeforePush: z.boolean().optional(),
});

export const refineSchema = z.object({
  instruction: z.string().trim().min(1),
});

export const assistantSchema = z.object({
  instruction: z.string().trim().min(1),
});

export const githubCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().optional(),
  redirectUri: z.string().url().optional(),
});

export function validate(schema) {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: parsed.error.errors[0]?.message || "Invalid request body",
        code: "VALIDATION_ERROR",
        details: parsed.error.flatten(),
      });
    }
    req.body = parsed.data;
    next();
  };
}
