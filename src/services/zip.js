const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { HttpError } = require('../util');

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const IGNORED = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$)/;

/**
 * Safely extracts a zip archive: rejects path traversal, skips symlinks,
 * enforces entry count and total uncompressed size limits.
 * Returns { contextDir, dockerfile } where contextDir holds the Dockerfile.
 */
function extractZip(zipPath, destDir, { maxEntries = 20000, maxTotalBytes = 1024 * 1024 * 1024 } = {}) {
  let zip;
  try {
    zip = new AdmZip(zipPath);
  } catch {
    throw new HttpError(400, "Le fichier n'est pas une archive .zip valide.", 'INVALID_ZIP');
  }

  let entries;
  try {
    entries = zip.getEntries();
  } catch {
    throw new HttpError(400, 'Archive .zip corrompue.', 'INVALID_ZIP');
  }
  if (entries.length === 0) throw new HttpError(400, "L'archive est vide.", 'EMPTY_ZIP');
  if (entries.length > maxEntries) {
    throw new HttpError(400, `Trop de fichiers dans l'archive (max ${maxEntries}).`, 'ZIP_TOO_MANY_ENTRIES');
  }

  const root = path.resolve(destDir);
  fs.mkdirSync(root, { recursive: true });
  let total = 0;

  for (const entry of entries) {
    const name = entry.entryName.replace(/\\/g, '/');
    if (IGNORED.test(name)) continue;
    if (name.includes('\0')) throw new HttpError(400, 'Nom de fichier invalide dans le zip.', 'ZIP_BAD_PATH');

    const target = path.resolve(root, name);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new HttpError(400, `Chemin interdit dans le zip : ${name}`, 'ZIP_BAD_PATH');
    }

    const mode = (entry.attr >>> 16) & S_IFMT;
    if (mode === S_IFLNK) continue;

    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }

    total += entry.header.size;
    if (total > maxTotalBytes) {
      throw new HttpError(400, 'Archive trop volumineuse une fois décompressée.', 'ZIP_TOO_LARGE');
    }

    let data;
    try {
      data = entry.getData();
    } catch {
      throw new HttpError(400, `Impossible de décompresser ${name}.`, 'INVALID_ZIP');
    }
    if (data.length > entry.header.size && entry.header.size > 0) {
      throw new HttpError(400, `Taille incohérente pour ${name}.`, 'INVALID_ZIP');
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }

  return findDockerContext(root);
}

function findDockerfile(dir) {
  try {
    return fs.readdirSync(dir).find((n) => n.toLowerCase() === 'dockerfile' && fs.statSync(path.join(dir, n)).isFile()) || null;
  } catch {
    return null;
  }
}

// Dockerfile at the root, or inside a single top-level folder (common when zipping a folder).
function findDockerContext(root) {
  let dockerfile = findDockerfile(root);
  if (dockerfile) return { contextDir: root, dockerfile };

  const items = fs.readdirSync(root).filter((n) => !n.startsWith('.') && n !== '__MACOSX');
  if (items.length === 1 && fs.statSync(path.join(root, items[0])).isDirectory()) {
    const sub = path.join(root, items[0]);
    dockerfile = findDockerfile(sub);
    if (dockerfile) return { contextDir: sub, dockerfile };
  }
  throw new HttpError(400, 'Aucun Dockerfile trouvé à la racine du zip.', 'NO_DOCKERFILE');
}

module.exports = { extractZip, findDockerContext };
