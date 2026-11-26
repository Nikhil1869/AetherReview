import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Each contender registers a unique file before looking for other owners. Two
// simultaneous contenders may both back off, but neither can miss a holder
// that registered earlier and is still in its critical section.
export class PublicationLocks {
  private readonly root: string;
  private readonly owned = new Map<string, string>();

  constructor(root: string) {
    this.root = root;
  }

  acquire(key: string): boolean {
    if (this.owned.has(key)) return false;
    const dir = join(this.root, encodeURIComponent(key) + ".lock");
    const ticket = process.pid + "-" + randomUUID();
    const path = join(dir, ticket);
    let registered = false;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(path, "", { flag: "wx", mode: 0o600 });
      registered = true;
      for (const other of readdirSync(dir)) {
        if (other === ticket) continue;
        const match = /^([1-9]\d*)-[a-f\d-]{36}$/.exec(other);
        if (!match) return false;
        try {
          process.kill(Number(match[1]), 0);
          return false;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ESRCH") return false;
          // Only the dead process could have created this particular UUID.
          try {
            unlinkSync(join(dir, other));
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          }
        }
      }
      this.owned.set(key, path);
      return true;
    } catch {
      return false;
    } finally {
      if (registered && !this.owned.has(key)) unlinkSync(path);
    }
  }

  release(key: string): void {
    const path = this.owned.get(key);
    if (!path) return;
    unlinkSync(path);
    this.owned.delete(key);
    // rmdir only succeeds while empty. A contender can safely retry ENOENT.
    try {
      rmdirSync(join(this.root, encodeURIComponent(key) + ".lock"));
    } catch {}
  }
}
