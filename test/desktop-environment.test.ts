import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { desktopEnvironment } from "../src/desktop-environment.js";

test("desktop environment restores the login PATH on macOS", async () => {
  const environment = await desktopEnvironment("darwin", { PATH: "/usr/bin", SHELL: "/bin/zsh", OMIT: undefined }, async () => "/opt/homebrew/bin:/usr/bin");
  assert.equal(environment.PATH, "/opt/homebrew/bin:/usr/bin");
  assert.equal(environment.THREADFERRY_DESKTOP, "1");
  assert.equal("OMIT" in environment, false);
});

test("desktop environment does not run interactive shell startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "threadferry-shell-"));
  const shell = join(directory, "login-shell");
  try {
    await writeFile(shell, "#!/bin/sh\ncase \"$1\" in *i*) exit 13;; esac\nprintf '\\n__THREADFERRY_PATH__%s' '/opt/homebrew/bin:/usr/bin'\n", { mode: 0o755 });
    const environment = await desktopEnvironment("darwin", { PATH: "/usr/bin", SHELL: shell });
    assert.equal(environment.PATH, "/opt/homebrew/bin:/usr/bin");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop environment restores the login PATH on Linux", async () => {
  let fallback = "";
  const environment = await desktopEnvironment("linux", { PATH: "/usr/bin" }, async (_environment, fallbackShell) => {
    fallback = fallbackShell;
    return "/home/user/.local/bin:/usr/bin";
  });
  assert.equal(environment.PATH, "/home/user/.local/bin:/usr/bin");
  assert.equal(fallback, "/bin/sh");
});

test("desktop environment leaves Windows PATH unchanged", async () => {
  let called = false;
  const resolver = async () => { called = true; return "/unexpected"; };
  assert.equal((await desktopEnvironment("win32", { PATH: "C:\\Windows" }, resolver)).PATH, "C:\\Windows");
  assert.equal(called, false);
});
