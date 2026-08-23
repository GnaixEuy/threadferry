import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  installOfficialWecomSkills,
  OFFICIAL_WECOM_SKILLS,
  OFFICIAL_WECOM_SKILLS_SOURCE,
  officialWecomSkillsInstalled,
} from "../src/wecom-skills.js";
import type { CommandRunner } from "../src/types.js";

async function writeSkills(root: string, source = OFFICIAL_WECOM_SKILLS_SOURCE): Promise<void> {
  await Promise.all(OFFICIAL_WECOM_SKILLS.map(async (name) => {
    const directory = join(root, name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: official ${name}\n---\n`, "utf8");
  }));
  await writeFile(join(dirname(root), ".skill-lock.json"), JSON.stringify({
    skills: Object.fromEntries(OFFICIAL_WECOM_SKILLS.map((name) => [name, {
      source,
      skillPath: `skills/${name}/SKILL.md`,
      skillFolderHash: "a".repeat(40),
    }])),
  }), "utf8");
}

test("official WeCom Skills require every canonical Skill and official provenance", async (t) => {
  const container = await mkdtemp(join(tmpdir(), "threadferry-skills-"));
  const root = join(container, "skills");
  t.after(() => rm(container, { recursive: true, force: true }));
  assert.equal(await officialWecomSkillsInstalled(root), false);
  await writeSkills(root, "someone/untrusted");
  assert.equal(await officialWecomSkillsInstalled(root), false);
  await writeSkills(root);
  assert.equal(await officialWecomSkillsInstalled(root), true);
});

test("Skill installer uses the official package and verifies the result", async (t) => {
  const container = await mkdtemp(join(tmpdir(), "threadferry-skills-install-"));
  const root = join(container, "skills");
  t.after(() => rm(container, { recursive: true, force: true }));
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    await writeSkills(root);
    return { stdout: "", stderr: "" };
  };

  await installOfficialWecomSkills(runner, root);
  assert.deepEqual(calls, [{
    command: "npx",
    args: ["--yes", "skills", "add", OFFICIAL_WECOM_SKILLS_SOURCE, "-y", "-g"],
  }]);

  await assert.rejects(installOfficialWecomSkills(async () => ({ stdout: "", stderr: "" }), join(root, "missing")), /安装不完整/);
});
