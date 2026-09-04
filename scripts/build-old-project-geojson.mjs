// Builds ../eldri-verkefni.geojson by listing everything under the
// "eldri-verkefni/" folder on Cloudinary (via the Admin API) and reading
// GPS-EXIF out of each new/changed image, on the server — not in every
// visitor's browser. Needs CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET as
// GitHub Actions secrets (never hardcode them here).
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import exifr from 'exifr';

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'lthr3qec';
const API_KEY = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;
const FOLDER_PREFIX = 'eldri-verkefni/';
const OUTPUT_FILE = path.join(process.cwd(), '..', 'eldri-verkefni.geojson');

if (!API_KEY || !API_SECRET) {
  throw new Error('CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET vantar (settu þau sem GitHub Actions secrets).');
}

const authHeader = 'Basic ' + Buffer.from(`${API_KEY}:${API_SECRET}`).toString('base64');

async function listAllResources() {
  const resources = [];
  let cursor = undefined;
  do {
    const url = new URL(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/resources/image`);
    url.searchParams.set('type', 'upload');
    url.searchParams.set('prefix', FOLDER_PREFIX);
    url.searchParams.set('max_results', '500');
    if (cursor) url.searchParams.set('next_cursor', cursor);

    const res = await fetch(url, { headers: { Authorization: authHeader } });
    if (!res.ok) {
      throw new Error(`Cloudinary Admin API villa: HTTP ${res.status} - ${await res.text()}`);
    }
    const data = await res.json();
    resources.push(...(data.resources || []));
    cursor = data.next_cursor;
  } while (cursor);
  return resources;
}

async function loadExistingGeojson() {
  try {
    const text = await readFile(OUTPUT_FILE, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    return { type: 'FeatureCollection', generatedAt: null, features: [] };
  }
}

async function readExifFromUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gat ekki sótt ${url}: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const gps = await exifr.gps(buffer).catch(() => null);
  const tags = await exifr
    .parse(buffer, { pick: ['DateTimeOriginal', 'CreateDate', 'DateTime', 'ModifyDate', 'GPSImgDirection'] })
    .catch(() => null);
  const rawDate = tags?.DateTimeOriginal || tags?.CreateDate || tags?.DateTime || tags?.ModifyDate || null;
  return {
    lat: gps && typeof gps.latitude === 'number' ? gps.latitude : null,
    lon: gps && typeof gps.longitude === 'number' ? gps.longitude : null,
    date: rawDate ? new Date(rawDate).toISOString() : null,
    heading: typeof tags?.GPSImgDirection === 'number' ? tags.GPSImgDirection : null,
  };
}

async function main() {
  const resources = await listAllResources();
  console.log(`Fann ${resources.length} myndir undir ${FOLDER_PREFIX} á Cloudinary.`);

  const existing = await loadExistingGeojson();
  const existingByPublicId = new Map(
    (existing.features || []).map((f) => [f.properties.publicId, f])
  );

  const features = [];
  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (const resource of resources) {
    const prev = existingByPublicId.get(resource.public_id);
    if (prev && prev.properties.version === resource.version) {
      features.push(prev); // óbreytt síðan síðast - ekki lesa EXIF aftur
      skipped++;
      continue;
    }

    const filename = resource.public_id.slice(FOLDER_PREFIX.length) + '.' + resource.format;
    try {
      const exif = await readExifFromUrl(resource.secure_url);
      if (exif.lat == null || exif.lon == null) {
        console.warn(`Sleppti ${filename}: engin GPS-gögn í EXIF`);
        failed++;
        continue;
      }
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [exif.lon, exif.lat] },
        properties: {
          filename,
          url: resource.secure_url,
          publicId: resource.public_id,
          version: resource.version,
          date: exif.date,
          heading: exif.heading,
        },
      });
      processed++;
    } catch (err) {
      console.warn(`Sleppti ${filename}: ${err.message}`);
      failed++;
    }
  }

  const geojson = {
    type: 'FeatureCollection',
    generatedAt: new Date().toISOString(),
    features,
  };

  await writeFile(OUTPUT_FILE, JSON.stringify(geojson, null, 2) + '\n');
  console.log(
    `Wrote ${features.length} features to ${OUTPUT_FILE} ` +
    `(${processed} new/changed, ${skipped} unchanged, ${failed} skipped/failed).`
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
