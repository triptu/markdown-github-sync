/** Minimal runtime identity stub: production code is bundled unchanged in adapter tests. */
export class TFile {
  constructor(public path: string, public stat: {size:number; mtime:number}) {}
}
export class App {}
