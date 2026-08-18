import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadWecomCliCredentials } from "../src/wecom-credentials.js";

async function writeCredentials(directory: string, payload: unknown): Promise<void> {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  await Promise.all([
    writeFile(join(directory, ".encryption_key"), key.toString("base64"), { mode: 0o600 }),
    writeFile(join(directory, "credentials.enc"), Buffer.concat([nonce, encrypted]), { mode: 0o600 }),
  ]);
}

test("loads encrypted bot credentials saved by wecom-cli", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "threadferry-wecom-credentials-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeCredentials(directory, {
    bot: { id: "bot-id", secret: "bot-secret", create_time: 1 },
    token: "access-token",
  });

  assert.deepEqual(await loadWecomCliCredentials(directory), {
    botId: "bot-id",
    secret: "bot-secret",
  });
});

test("ignores unavailable, corrupt, or incomplete wecom-cli credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "threadferry-wecom-credentials-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  assert.equal(await loadWecomCliCredentials(directory), undefined);
  await writeFile(join(directory, ".encryption_key"), randomBytes(32).toString("base64"));
  await writeFile(join(directory, "credentials.enc"), "not encrypted credentials");
  assert.equal(await loadWecomCliCredentials(directory), undefined);
  await writeCredentials(directory, { bot: { id: "bot-id" } });
  assert.equal(await loadWecomCliCredentials(directory), undefined);
});
