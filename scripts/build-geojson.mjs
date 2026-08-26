// Builds ../photos.geojson from every JPG/JPEG in ../myndir.
// Run from the "scripts" directory (the GitHub Action does `working-directory: scripts`).
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import exifr from 'exifr';

const REPO_ROOT = path.join(process.cwd(), '..');
const IMAGES_DIR = path.join(REPO_ROOT, 'myndir');
const OUTPUT_FILE = path.join(REPO_ROOT, 'photos.geojson');
const VALID_EXT = new Set(['.jpg', '.jpeg']);

// Same hash git/GitHub use for a blob's "sha" — lets the browser cache compare
// against the live GitHub API listing and skip files it already has.
function gitBlobSha1(buffer) {
  const header = Buffer.from(`blob ${buffer.length}\0`);
  return createHash('sha1').update(Buffer.concat([header, buffer])).digest('hex');
}

async function main() {
  let entries;
  try {
    entries = await readdir(IMAGES_DIR, { withFileTypes: true });
  } catch (err) {
    console.warn(`No ${IMAGES_DIR} directory found, writing empty geojson.`);
    entries = [];
  }

  const files = entries
    .filter((e) => e.isFile() && VALID_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort();

  const features = [];
  let skipped = 0;

  for (const name of files) {
    const buffer = await readFile(path.join(IMAGES_DIR, name));
    let gps = null;
    let tags = null;
    try {
      tags = await exifr.parse(buffer, {
        pick: ['DateTimeOriginal', 'CreateDate', 'GPSImgDirection'],
      });
      gps = await exifr.gps(buffer);
    } catch (err) {
      console.warn(`Skipping ${name}: EXIF parse failed (${err.message})`);
      skipped++;
      continue;
    }

    if (!gps || typeof gps.latitude !== 'number' || typeof gps.longitude !== 'number') {
      console.warn(`Skipping ${name}: no GPS data in EXIF`);
      skipped++;
      continue;
    }

    const rawDate = tags?.DateTimeOriginal || tags?.CreateDate || null;

    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [gps.longitude, gps.latitude] },
      properties: {
        filename: name,
        path: `myndir/${name}`,
        sha: gitBlobSha1(buffer),
        date: rawDate ? new Date(rawDate).toISOString() : null,
        heading: typeof tags?.GPSImgDirection === 'number' ? tags.GPSImgDirection : null,
      },
    });
  }

  const geojson = {
    type: 'FeatureCollection',
    generatedAt: new Date().toISOString(),
    features,
  };

  await writeFile(OUTPUT_FILE, JSON.stringify(geojson, null, 2) + '\n');
  console.log(`Wrote ${features.length} features to ${OUTPUT_FILE} (${skipped} skipped, no/invalid GPS).`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
