// Resolve a file beneath a repository's physical root, including new files.
// Check both lexical containment and the nearest existing ancestor so symlinks /
// Windows junctions cannot redirect reads or writes outside the repository.
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, join } from 'node:path';

export function isOutside(root, target) {
  const rel = relative(root, target);
  return rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel);
}

export function resolveRepoPath(repoRoot, path) {
  if (typeof path !== 'string' || !path || path.includes('\0') || /^[a-z]:[^\\/]/i.test(path)) return null;
  const root = resolve(repoRoot);
  const target = resolve(root, path.replace(/\\/g, '/'));
  if (target === root || isOutside(root, target)) return null;
  try {
    const physicalRoot = realpathSync.native(root);
    let ancestor = target;
    for (;;) {
      try { lstatSync(ancestor); }
      catch (error) {
        if (error.code !== 'ENOENT' || dirname(ancestor) === ancestor) return null;
        ancestor = dirname(ancestor);
        continue;
      }
      // Broken links / loops are refused instead of treated as missing paths.
      const physicalAncestor = realpathSync.native(ancestor);
      if (isOutside(physicalRoot, physicalAncestor)) return null;
      return join(physicalAncestor, relative(ancestor, target));
    }
  } catch { return null; }
}
