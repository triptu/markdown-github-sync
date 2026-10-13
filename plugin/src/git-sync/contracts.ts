export type FileMode = "100644" | "100755";
export interface Entry { oid: string; mode: FileMode; data: string }
export type Snapshot = Record<string, Entry>;
export interface CommitSnapshot { oid: string; treeOid: string; files: Snapshot }
export interface RepositoryIdentity { id: string; owner: string; name: string; branch: string }
export type Changes = Record<string, Entry | null>;
export type PublishResult = { kind: "accepted" } | { kind: "head-moved" } | { kind: "unknown" } | { kind: "rejected"; message: string };
export interface Repository {
  identity(): Promise<RepositoryIdentity>;
  head(): Promise<CommitSnapshot>;
  readCommit(oid: string): Promise<CommitSnapshot>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  prepare(parent: CommitSnapshot, changes: Changes, message: string): Promise<CommitSnapshot>;
  publish(expectedHead: string, candidate: string): Promise<PublishResult>;
}
export type ApplyResult = { kind: "applied" } | { kind: "changed" } | { kind: "blocked"; reason: string };
export interface LocalVault {
  capture(): Promise<Snapshot>;
  apply(path: string, expected: Entry | null, next: Entry | null): Promise<ApplyResult>;
}
export interface DurableStore {
  load(): Promise<unknown>;
  save(state: unknown): Promise<void>;
}
