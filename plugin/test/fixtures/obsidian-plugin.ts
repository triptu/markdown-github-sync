export { TFile, App, FileView } from "./obsidian";
export class Plugin {
  app: { savedSettings?: unknown } = {};
  async saveData(value: unknown): Promise<void> { this.app.savedSettings = structuredClone(value); }
  async loadData(): Promise<unknown> { return this.app.savedSettings; }
  addStatusBarItem() { return { addClass() {}, toggleClass() {}, setText() {}, onclick: null }; }
  addSettingTab(_value: unknown) {}
  addRibbonIcon(..._args: unknown[]) {}
  addCommand(_value: unknown) {}
  registerEvent(_value: unknown) {}
  registerDomEvent(..._args: unknown[]) {}
}
export class Modal { constructor(public app: unknown) {} open() {} close() {} }
export class Notice { constructor(..._args: unknown[]) {} }
export class PluginSettingTab { constructor(..._args: unknown[]) {} }
export class SecretComponent {}
export class Setting {}
export function requestUrl(): never { throw new Error("Network forbidden in safety regressions"); }
