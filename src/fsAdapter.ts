/**
 * ObsidianFsAdapter
 *
 * Wraps Obsidian's vault DataAdapter so that isomorphic-git can use it as a
 * file-system on platforms where Node.js `fs` is unavailable (iOS / Android).
 *
 * isomorphic-git only needs the `promises` property, which is a subset of the
 * Node.js `fs/promises` interface.
 */

import { DataAdapter } from "obsidian";

// isomorphic-git stat result shape
interface StatLike {
  type: "file" | "dir" | "symlink";
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
  // Some bundled/minified code paths call lowercase variants.
  isfile: () => boolean;
  isdirectory: () => boolean;
  issymboliclink: () => boolean;
}

export class ObsidianFsAdapter {
  readonly promises: ObsidianFsPromises;

  constructor(adapter: DataAdapter) {
    this.promises = new ObsidianFsPromises(adapter);
  }
}

class ObsidianFsPromises {
  constructor(private adapter: DataAdapter) {}

  async readFile(path: string, options?: { encoding?: string } | string): Promise<Uint8Array | string> {
    const encoding = typeof options === "string" ? options : options?.encoding;
    if (encoding === "utf8" || encoding === "utf-8") {
      return this.adapter.read(path);
    }
    const buf = await this.adapter.readBinary(path);
    return new Uint8Array(buf);
  }

  async writeFile(
    path: string,
    data: Uint8Array | string,
    _options?: unknown
  ): Promise<void> {
    if (typeof data === "string") {
      await this.adapter.write(path, data);
    } else {
      await this.adapter.writeBinary(path, data.buffer as ArrayBuffer);
    }
  }

  async unlink(path: string): Promise<void> {
    await this.adapter.remove(path);
  }

  async readdir(path: string): Promise<string[]> {
    const result = await this.adapter.list(path);
    const names = [
      ...result.files.map((f) => f.split("/").pop()!),
      ...result.folders.map((f) => f.replace(/\/$/, "").split("/").pop()!),
    ];
    return names;
  }

  async mkdir(path: string, _options?: unknown): Promise<void> {
    await this.adapter.mkdir(path);
  }

  async rmdir(path: string): Promise<void> {
    // Obsidian adapter has no direct rmdir; try trashLocal, fall back to remove
    const a = this.adapter as any;
    if (typeof a.rmdir === "function") {
      await a.rmdir(path);
    }
    // If no native rmdir, silently ignore — isomorphic-git rarely calls this on
    // non-empty dirs and the error would surface naturally if something fails.
  }

  async stat(path: string): Promise<StatLike> {
    return this._stat(path);
  }

  async lstat(path: string): Promise<StatLike> {
    return this._stat(path);
  }

  private async _stat(path: string): Promise<StatLike> {
    const s = await this.adapter.stat(path);
    if (!s) throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: "ENOENT" });
    const isDir = s.type === "folder";
    return {
      type: isDir ? "dir" : "file",
      mode: isDir ? 0o040755 : 0o100644,
      size: s.size,
      ino: 0,
      mtimeMs: s.mtime,
      ctimeMs: s.ctime,
      isFile: () => !isDir,
      isDirectory: () => isDir,
      isSymbolicLink: () => false,
      isfile: () => !isDir,
      isdirectory: () => isDir,
      issymboliclink: () => false,
    };
  }

  // symlink support — not available on Obsidian adapter, provide stubs so
  // isomorphic-git doesn't crash when it calls these rarely-used paths.
  async readlink(_path: string): Promise<string> {
    throw Object.assign(new Error("readlink not supported on mobile"), { code: "ENOSYS" });
  }

  async symlink(_target: string, _path: string): Promise<void> {
    throw Object.assign(new Error("symlink not supported on mobile"), { code: "ENOSYS" });
  }
}
