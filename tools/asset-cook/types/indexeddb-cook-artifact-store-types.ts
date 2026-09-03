/** Browser database factory injection used by production globals and deterministic tests. */
export interface IndexedDbCookArtifactStoreOptions {
  readonly indexedDB?: IDBFactory;
}
