import { describe, expect, it } from "vitest";
import { ObsidianFsAdapter } from "../src/fsAdapter";
import type { DataAdapter, ListResult, StatResult } from "./mocks/obsidian";

/** Tiny in-memory adapter for exercising ObsidianFsAdapter. */
function createMemoryAdapter(initial: Map<string, { kind: "file" | "folder"; body?: Uint8Array }>) {
  const store = initial;

  const adapter: DataAdapter = {
    async read(path: string): Promise<string> {
      const ent = store.get(path);
      if (!ent || ent.kind !== "file" || !ent.body) throw new Error("ENOENT");
      return new TextDecoder().decode(ent.body);
    },
    async readBinary(path: string): Promise<ArrayBuffer> {
      const ent = store.get(path);
      if (!ent || ent.kind !== "file" || !ent.body) throw new Error("ENOENT");
      return ent.body.buffer.slice(
        ent.body.byteOffset,
        ent.body.byteOffset + ent.body.byteLength
      ) as ArrayBuffer;
    },
    async write(path: string, data: string): Promise<void> {
      store.set(path, { kind: "file", body: new TextEncoder().encode(data) });
    },
    async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
      store.set(path, { kind: "file", body: new Uint8Array(data) });
    },
    async remove(path: string): Promise<void> {
      store.delete(path);
    },
    async list(path: string): Promise<ListResult> {
      const prefix = path === "" ? "" : path.endsWith("/") ? path : `${path}/`;
      const files: string[] = [];
      const folders: string[] = [];
      for (const p of store.keys()) {
        if (!p.startsWith(prefix) || p === path) continue;
        const rest = p.slice(prefix.length);
        if (rest.includes("/")) {
          const top = rest.split("/")[0];
          if (top && !folders.includes(`${prefix}${top}/`)) {
            folders.push(`${prefix}${top}/`);
          }
        } else {
          files.push(p);
        }
      }
      return { files, folders };
    },
    async mkdir(path: string): Promise<void> {
      store.set(path.endsWith("/") ? path : `${path}/`, { kind: "folder" });
    },
    async stat(path: string): Promise<StatResult | null> {
      const ent = store.get(path);
      if (!ent) return null;
      const size = ent.body?.byteLength ?? 0;
      const t = Date.now();
      return {
        type: ent.kind === "folder" ? "folder" : "file",
        size,
        mtime: t,
        ctime: t,
      };
    },
  };

  return adapter;
}

describe("ObsidianFsAdapter", () => {
  it("readFile returns utf8 string when encoding is utf8", async () => {
    const adapter = createMemoryAdapter(new Map([["note.md", { kind: "file", body: new TextEncoder().encode("hello") }]]));
    const fs = new ObsidianFsAdapter(adapter as any).promises;
    await expect(fs.readFile("note.md", "utf8")).resolves.toBe("hello");
  });

  it("readFile returns Uint8Array for binary read", async () => {
    const bytes = new Uint8Array([0, 255, 128]);
    const adapter = createMemoryAdapter(new Map([["b.bin", { kind: "file", body: bytes }]]));
    const fs = new ObsidianFsAdapter(adapter as any).promises;
    const out = await fs.readFile("b.bin");
    expect(out).toBeInstanceOf(Uint8Array);
    expect([...(out as Uint8Array)]).toEqual([0, 255, 128]);
  });

  it("writeFile then readFile round-trips text", async () => {
    const adapter = createMemoryAdapter(new Map());
    const fs = new ObsidianFsAdapter(adapter as any).promises;
    await fs.writeFile("a.txt", "xyz");
    await expect(fs.readFile("a.txt", "utf8")).resolves.toBe("xyz");
  });

  it("stat exposes file vs directory for isomorphic-git", async () => {
    const adapter = createMemoryAdapter(
      new Map([
        ["dir/", { kind: "folder" }],
        ["dir/f.md", { kind: "file", body: new TextEncoder().encode("x") }],
      ])
    );
    const fs = new ObsidianFsAdapter(adapter as any).promises;
    const st = await fs.stat("dir/f.md");
    expect(st.isFile()).toBe(true);
    expect(st.isDirectory()).toBe(false);
    const stDir = await fs.stat("dir/");
    expect(stDir.isDirectory()).toBe(true);
  });
});
