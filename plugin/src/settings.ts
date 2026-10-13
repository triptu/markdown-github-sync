export interface Settings {
  format: 2;
  owner: string;
  repository: string;
  branch: string;
  secretId: string;
  deviceName: string;
  automatic: boolean;
  configuration?: boolean;
}
export const defaultSettings = (): Settings => ({
  format: 2,
  owner: "",
  repository: "",
  branch: "main",
  secretId: "",
  deviceName: "Obsidian",
  automatic: true,
  configuration: true,
});
export function parseSettings(value: unknown): Settings {
  if (value === null || value === undefined) return defaultSettings();
  if (typeof value !== "object" || Array.isArray(value) || Reflect.get(value, "format") !== 2)
    throw new Error(
      "Unrecognized settings. This plugin cannot migrate Cloudflare credentials or checkpoints.",
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
  const automatic: unknown = Reflect.get(value, "automatic");
  if (typeof automatic !== "boolean")
    throw new Error("Invalid automatic sync setting");
  defaults.automatic = automatic;
  const configuration: unknown = Reflect.get(value, "configuration");
  if (configuration !== undefined && typeof configuration !== "boolean")
    throw new Error("Invalid initial configuration scope setting");
  defaults.configuration = configuration === true;
  return defaults;
}
