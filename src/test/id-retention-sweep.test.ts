import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/admin-data.server", () => ({ assertRole: vi.fn() }));

import { sweepOrphanedIdFolders, type IdSweepDeps } from "@/lib/verification-data.server";

const id = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

function fake(folders: string[], live: string[], filesPer = 2) {
  const removed: string[] = [];
  const deps: IdSweepDeps = {
    listFolders: async (offset, limit) => folders.slice(offset, offset + limit),
    listFiles: async (folder) =>
      Array.from({ length: filesPer }, (_, i) => `f${i}.jpg`).map((n) => n),
    userExists: async (folderId) => live.includes(folderId),
    remove: async (paths) => {
      removed.push(...paths);
    },
  };
  return { deps, removed };
}

describe("ID image retention: kept while the account exists, removed when it does not", () => {
  it("keeps every file of a live member and removes every file of a deleted one", async () => {
    const { deps, removed } = fake([id(1), id(2), id(3)], [id(1), id(3)]);
    const result = await sweepOrphanedIdFolders(deps);
    expect(result).toEqual({ scanned: 3, removedFolders: 1, removedFiles: 2 });
    expect(removed).toEqual([`${id(2)}/f0.jpg`, `${id(2)}/f1.jpg`]);
  });

  it("never touches anything that is not a member-id folder", async () => {
    const { deps, removed } = fake(["control", ".emptyFolderPlaceholder", "../etc", id(9)], []);
    const result = await sweepOrphanedIdFolders(deps);
    expect(result.scanned).toBe(1);
    expect(removed.every((p) => p.startsWith(id(9)))).toBe(true);
  });

  it("a lookup failure stops the sweep instead of deleting (nothing is removed on doubt)", async () => {
    const { deps, removed } = fake([id(1), id(2)], []);
    deps.userExists = async () => {
      throw new Error("auth is down");
    };
    await expect(sweepOrphanedIdFolders(deps)).rejects.toThrow("auth is down");
    expect(removed).toEqual([]);
  });

  it("pages through large buckets and is a no-op when everyone is active", async () => {
    const many = Array.from({ length: 250 }, (_, i) => id(i + 1));
    const { deps, removed } = fake(many, many);
    const result = await sweepOrphanedIdFolders(deps);
    expect(result).toEqual({ scanned: 250, removedFolders: 0, removedFiles: 0 });
    expect(removed).toEqual([]);
  });
});
