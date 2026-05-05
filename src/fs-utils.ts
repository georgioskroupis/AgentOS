import { access, chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, ".."), resolve(here, "../..")];
  return candidates.find((candidate) => existsSync(join(candidate, "templates"))) ?? candidates[0];
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        out.push(path);
      }
    }
  }
  if (await exists(root)) {
    await walk(root);
  }
  return out.sort();
}

export async function copyFileEnsuringDir(source: string, target: string): Promise<void> {
  await ensureDir(dirname(target));
  await copyFile(source, target);
}

export async function writeTextEnsuringDir(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content, "utf8");
}

export async function writeTextAtomicEnsuringDir(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

export async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function makeExecutable(path: string): Promise<void> {
  await chmod(path, 0o755).catch(() => undefined);
}

export async function removePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export function rel(from: string, to: string): string {
  return relative(from, to).split("\\").join("/");
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
