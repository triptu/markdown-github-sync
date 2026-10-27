import { defaultCommitDateFormat, defaultCommitMessageTemplate } from "./commit-message";

export interface Settings {
  format: 2;
  owner: string;
  repository: string;
  branch: string;
  secretId: string;
  deviceName: string;
  automatic: boolean;
  commitMessageTemplate: string;
  commitDateFormat: string;
}
export const defaultSettings = (): Settings => ({
  format: 2,
  owner: "",
  repository: "",
  branch: "main",
  secretId: "",
  deviceName: "Obsidian",
  automatic: true,
  commitMessageTemplate: defaultCommitMessageTemplate,
  commitDateFormat: defaultCommitDateFormat,
});
export function parseSettings(value: unknown): Settings {
  if (value === null || value === undefined) return defaultSettings();
  if (typeof value !== "object" || Array.isArray(value) || Reflect.get(value, "format") !== 2)
    throw new Error(
      "Unrecognized settings.",
    );
  const defaults = defaultSettings();
  for (const key of [
    "owner",
    "repository",
    "branch",
    "secretId",
    "deviceName",
  ] as const) {
    const field: unknown = Reflect.get(value, key);
    if (typeof field !== "string" || field.length > 256)
      throw new Error(`Invalid setting: ${key}`);
    defaults[key] = field;
  }
  for (const key of ["commitMessageTemplate", "commitDateFormat"] as const) {
    const field: unknown = Reflect.get(value, key);
    if (field === undefined) continue;
    if (typeof field !== "string" || !field.trim() || field.length > 256 || /[\r\n\0]/.test(field))
      throw new Error("Commit message and date format must be a single line, 1–256 characters.");
    defaults[key] = field;
  }
  const automatic: unknown = Reflect.get(value, "automatic");
  if (typeof automatic !== "boolean")
    throw new Error("Invalid automatic sync setting");
  defaults.automatic = automatic;
  return defaults;
}
