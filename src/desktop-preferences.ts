import { readFile, writeFile } from "node:fs/promises";

export interface DesktopPreferences {
  autoStartService: boolean;
  launchAtLogin: boolean;
  openManagementOnLaunch: boolean;
  showDockIcon: boolean;
}

export const DEFAULT_DESKTOP_PREFERENCES: DesktopPreferences = {
  autoStartService: true,
  launchAtLogin: false,
  openManagementOnLaunch: false,
  showDockIcon: false,
};

export function normalizeDesktopPreferences(value: unknown): DesktopPreferences {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    autoStartService: input.autoStartService !== false,
    launchAtLogin: input.launchAtLogin === true,
    openManagementOnLaunch: input.openManagementOnLaunch === true,
    showDockIcon: input.showDockIcon === true,
  };
}

export async function readDesktopPreferences(path: string): Promise<DesktopPreferences> {
  try {
    return normalizeDesktopPreferences(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_DESKTOP_PREFERENCES };
    }
    throw error;
  }
}

export async function writeDesktopPreferences(path: string, value: unknown): Promise<DesktopPreferences> {
  const preferences = normalizeDesktopPreferences(value);
  await writeFile(path, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600 });
  return preferences;
}
