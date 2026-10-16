import crypto from "crypto";

const ALGO = "aes-256-gcm";
const PREFIX = "enc:v1:";

function getKey() {
  const secret =
    process.env.ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    "dev-only-encryption-key-change-me";
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptSecret(plain) {
  if (!plain) return "";
  if (String(plain).startsWith(PREFIX)) return plain;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plain), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return (
    PREFIX +
    Buffer.concat([iv, tag, encrypted]).toString("base64url")
  );
}

export function decryptSecret(value) {
  if (!value) return "";
  if (!String(value).startsWith(PREFIX)) return value;

  const raw = Buffer.from(String(value).slice(PREFIX.length), "base64url");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
}

export function maskSecret(value) {
  const plain = decryptSecret(value);
  if (!plain) return "";
  return "••••••••••••" + plain.slice(-4);
}
