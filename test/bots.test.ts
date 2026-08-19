import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  authorizeHint,
  botConfigDir,
  botStatus,
  loadBotCredentials,
  validateAgentId,
  wecomEnv,
} from "../src/bots.js";

// 复刻 wecom-cli 的加密存储格式，用来验证按目录隔离读取。
async function writeCredentials(directory: string, botId: string, secret: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const payload = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify({ bot: { id: botId, secret } }), "utf8")),
    cipher.final(),
  ]);
  await writeFile(join(directory, ".encryption_key"), key.toString("base64"), { mode: 0o600 });
  await writeFile(join(directory, "credentials.enc"), Buffer.concat([nonce, payload, cipher.getAuthTag()]), { mode: 0o600 });
}

test("agent ids must be safe to use as a directory name but may contain Chinese and spaces", () => {
  assert.equal(validateAgentId("corp-2"), "corp-2");
  assert.equal(validateAgentId("a".repeat(128)), "a".repeat(128));
  // 中文和空格是合法目录名，v5 起支持，恢复支持。
  assert.equal(validateAgentId("叶翔"), "叶翔");
  assert.equal(validateAgentId("代码审查 Agent"), "代码审查 Agent");
  // 路径分隔符、控制字符、`.`/`..`、开头结尾空格和超长会拼进凭据目录路径，必须挡住。
  for (const bad of ["", "../escape", "a/b", "a\\b", ".", "..", " leading", "trailing ", "a\nb", "a".repeat(129)]) {
    assert.throws(() => validateAgentId(bad), /无效/);
    assert.throws(() => botConfigDir(bad), /无效/);
  }
});

test("every agent gets its own credential directory", () => {
  // 没有特例：default 也走统一路径，不再复用 wecom-cli 的 ~/.config/wecom。
  assert.equal(botConfigDir("default"), join(homedir(), ".threadferry", "wecom", "default"));
  assert.equal(botConfigDir("corp2"), join(homedir(), ".threadferry", "wecom", "corp2"));
  assert.notEqual(botConfigDir("default"), join(homedir(), ".config", "wecom"));
  assert.equal(botConfigDir("corp2", "/custom/dir"), "/custom/dir");
  assert.throws(() => botConfigDir("corp2", "relative/dir"), /绝对路径/);
});

test("wecomEnv only overrides the wecom-cli config directory", () => {
  const environment = wecomEnv("/bots/a", { PATH: "/usr/bin", WECOM_CLI_CONFIG_DIR: "/old" });
  assert.equal(environment.WECOM_CLI_CONFIG_DIR, "/bots/a");
  assert.equal(environment.PATH, "/usr/bin");
});

test("credentials are read from each agent's own directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadferry-bots-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  await writeCredentials(alpha, "aib-alpha", "secret-alpha");
  await writeCredentials(beta, "aib-beta", "secret-beta");

  assert.deepEqual(await loadBotCredentials("alpha", alpha), {
    botId: "aib-alpha",
    secret: "secret-alpha",
    configDir: alpha,
  });
  assert.equal((await loadBotCredentials("beta", beta))?.botId, "aib-beta");
  // 未授权目录返回 undefined，而不是抛错或串到别的 Agent。
  assert.equal(await loadBotCredentials("gamma", join(root, "missing")), undefined);
});

test("bot status reports authorization without leaking the secret", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadferry-bots-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "corp2");
  await writeCredentials(dir, "aib-corp2", "secret-corp2");

  const ready = await botStatus("corp2", dir);
  assert.deepEqual(ready, { name: "corp2", configDir: dir, authorized: true, botId: "aib-corp2" });
  assert.doesNotMatch(JSON.stringify(ready), /secret/);

  const missing = await botStatus("corp3", join(root, "corp3"));
  assert.equal(missing.authorized, false);
  assert.equal(missing.botId, undefined);

  const hint = authorizeHint("corp3", join(root, "corp3"));
  assert.match(hint, /threadferry agent login corp3/);
  assert.match(hint, /WECOM_CLI_CONFIG_DIR=.*wecom-cli auth init/s);
});
