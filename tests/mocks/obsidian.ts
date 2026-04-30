/**
 * Minimal stubs so modules under test can import `obsidian` in Vitest (Node).
 * Extend when additional exports are needed.
 */

export interface StatResult {
  type: "file" | "folder";
  size: number;
  mtime: number;
  ctime: number;
}

export interface ListResult {
  files: string[];
  folders: string[];
}

/** Subset of Obsidian DataAdapter used by ObsidianFsAdapter. */
export interface DataAdapter {
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<ArrayBuffer>;
  write(path: string, data: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
  list(path: string): Promise<ListResult>;
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<StatResult | null>;
}
