import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_DESKTOP_PREFERENCES,
  normalizeDesktopPreferences,
  readDesktopPreferences,
  writeDesktopPreferences,
} from "../src/desktop-preferences.js";

test("desktop preferences are validated and persist without accepting truthy strings", async () => {
  assert.deepEqual(normalizeDesktopPreferences({
    autoStartService: false,
    launchAtLogin: "yes",
    openManagementOnLaunch: true,
    showDockIcon: 1,
  }), {
    autoStartService: false,
    launchAtLogin: false,
    openManagementOnLaunch: true,
    showDockIcon: false,
  });

  const directory = await mkdtemp(join(tmpdir(), "threadferry-preferences-"));
  const path = join(directory, "desktop-preferences.json");
  try {
    assert.deepEqual(await readDesktopPreferences(path), DEFAULT_DESKTOP_PREFERENCES);
    const saved = await writeDesktopPreferences(path, { launchAtLogin: true });
    assert.deepEqual(await readDesktopPreferences(path), saved);
    assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);
    await writeFile(path, "not json");
    assert.deepEqual(await readDesktopPreferences(path), DEFAULT_DESKTOP_PREFERENCES);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
