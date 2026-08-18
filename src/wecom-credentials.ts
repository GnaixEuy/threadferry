import { createDecipheriv } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function credential(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : undefined;
}

export async function loadWecomCliCredentials(
  directory = process.env.WECOM_CLI_CONFIG_DIR || join(homedir(), ".config", "wecom"),
): Promise<{ botId: string; secret: string } | undefined> {
  try {
    // ponytail: wecom-cli has no credential export command; remove this reader when it exposes one.
    const [encodedKey, encrypted] = await Promise.all([
      readFile(join(directory, ".encryption_key"), "utf8"),
      readFile(join(directory, "credentials.enc")),
    ]);
    const key = Buffer.from(encodedKey.trim(), "base64");
    if (key.length !== 32 || encrypted.length < NONCE_BYTES + TAG_BYTES) return undefined;

    const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(0, NONCE_BYTES));
    decipher.setAuthTag(encrypted.subarray(-TAG_BYTES));
    const plaintext = Buffer.concat([
      decipher.update(encrypted.subarray(NONCE_BYTES, -TAG_BYTES)),
      decipher.final(),
    ]);
    const parsed = JSON.parse(plaintext.toString("utf8")) as { bot?: { id?: unknown; secret?: unknown } };
    const botId = credential(parsed.bot?.id);
    const secret = credential(parsed.bot?.secret);
    return botId && secret ? { botId, secret } : undefined;
  } catch {
    return undefined;
  }
}
