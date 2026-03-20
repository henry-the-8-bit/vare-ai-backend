import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const key = process.env["ENCRYPTION_KEY"];
  if (!key) {
    throw new Error("ENCRYPTION_KEY environment variable is not set");
  }
  return Buffer.from(key, "hex");
}

export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("hex");
}

export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
  const data = Buffer.from(ciphertext, "hex");
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

export function generateApiKey(prefix: "vare_live_sk" | "vare_test_sk" = "vare_live_sk"): string {
  const secret = process.env["VARE_API_SECRET"];
  if (!secret) {
    throw new Error("VARE_API_SECRET environment variable is not set");
  }
  const random = crypto.randomBytes(24).toString("hex");
  const hmac = crypto.createHmac("sha256", secret).update(random).digest("hex").slice(0, 16);
  return `${prefix}_${random}${hmac}`;
}
