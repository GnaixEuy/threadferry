import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { runCommand } from "./process.js";
import type { CommandRunner } from "./types.js";

export const OFFICIAL_WECOM_SKILLS_SOURCE = "WecomTeam/wecom-unified";
export const OFFICIAL_WECOM_SKILLS = ["wecom-unified"] as const;
const OFFICIAL_WECOM_REFERENCES = [
  "wecomcli-calendar.md", "wecomcli-contact.md", "wecomcli-disk.md", "wecomcli-doc-manage.md",
  "wecomcli-doc.md", "wecomcli-email.md", "wecomcli-media.md", "wecomcli-meeting.md",
  "wecomcli-message.md", "wecomcli-sheet.md", "wecomcli-smartpage.md", "wecomcli-smartsheet.md",
  "wecomcli-todo.md",
] as const;

export function officialWecomSkillsRoot(): string {
  return join(homedir(), ".agents", "skills");
}

export function officialWecomSkillPaths(root = officialWecomSkillsRoot()): string[] {
  return OFFICIAL_WECOM_SKILLS.map((name) => join(root, name));
}

export async function officialWecomSkillsInstalled(root = officialWecomSkillsRoot()): Promise<boolean> {
  let locked: Record<string, { source?: unknown; skillPath?: unknown; skillFolderHash?: unknown }>;
  try {
    const document = JSON.parse(await readFile(join(dirname(root), ".skill-lock.json"), "utf8")) as { skills?: unknown };
    if (!document.skills || typeof document.skills !== "object" || Array.isArray(document.skills)) return false;
    locked = document.skills as typeof locked;
  } catch {
    return false;
  }
  const checks = await Promise.all(OFFICIAL_WECOM_SKILLS.map(async (name) => {
    const entry = locked[name];
    if (entry?.source !== OFFICIAL_WECOM_SKILLS_SOURCE
      || entry.skillPath !== `skills/${name}/SKILL.md`
      || typeof entry.skillFolderHash !== "string"
      || !/^[a-f0-9]{40}$/.test(entry.skillFolderHash)) return false;
    try {
      const skill = await readFile(join(root, name, "SKILL.md"), "utf8");
      const references = new Set(await readdir(join(root, name, "references")));
      if (!OFFICIAL_WECOM_REFERENCES.every((reference) => references.has(reference))) return false;
      return new RegExp(`^name:\\s*${name}\\s*$`, "m").test(skill) && /^description:\s*\S/m.test(skill);
    } catch {
      return false;
    }
  }));
  return checks.every(Boolean);
}

export async function installOfficialWecomSkills(
  runner: CommandRunner = runCommand,
  root = officialWecomSkillsRoot(),
): Promise<void> {
  await runner("npx", ["--yes", "skills", "add", OFFICIAL_WECOM_SKILLS_SOURCE, "-y", "-g"], { timeoutMs: 5 * 60_000 });
  if (!await officialWecomSkillsInstalled(root)) throw new Error("官方企业微信 Skill 安装不完整，请重新运行 threadferry skills install");
}
