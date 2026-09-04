(() => {
  'use strict';

  // ---------------------------------------------------------------------
  // Config — adjust if this map is reused for a different repo/folder.
  // ---------------------------------------------------------------------
  const REPO_OWNER = 'nonni123';
  const REPO_NAME = 'Jardkonnun';
  const REPO_BRANCH = 'main';
  const IMAGES_PATH = 'myndir';

  const RAW_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}`;
  const CONTENTS_API_URL =
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${IMAGES_PATH}?ref=${REPO_BRANCH}`;
  const GEOJSON_URL = 'photos.geojson';

  // Nýrri myndir eru núna hlaðnar beint upp á Cloudinary (sjá "Ljósmynd"
  // dálkinn í miðlægu CSV skránni — annaðhvort ber GitHub-skráarheiti fyrir
  // eldri myndir, eða full Cloudinary-slóð fyrir nýjar). Cloudinary sviptir
  // GPS-EXIF af myndunum við afhendingu, svo þessar myndir eru staðsettar á
  // hnitum punktsins sjálfs (X/Y dálkarnir) í stað þess að lesa EXIF.
  const CENTRAL_CSV_URL = `${RAW_BASE}/Jardkonnun2026_central.csv`;

  const CACHE_KEY = 'jkmap_photo_cache_v1';
  const LABEL_ZOOM_THRESHOLD = 15;
  const VALID_EXT = /\.(jpe?g)$/i;
  const REFRESH_CONCURRENCY = 4;

  // "Eldri verkefni" — óháð myndamappa (t.d. úr eldri verkefnum) sem lifir í
  // þessu sama repo-i, ekki tengd neinum mastrapunkti. Sömu EXIF-GPS reglur
  // gilda og fyrir myndir/ - engin CSV-tenging þarf.
  const OLD_PROJECT_OWNER = 'nonni123';
  const OLD_PROJECT_REPO = 'JarMyndir';
  const OLD_PROJECT_BRANCH = 'main';
  const OLD_PROJECT_PATH = 'eldri-verkefni';
  const OLD_PROJECT_RAW_BASE = `https://raw.githubusercontent.com/${OLD_PROJECT_OWNER}/${OLD_PROJECT_REPO}/${OLD_PROJECT_BRANCH}`;
  const OLD_PROJECT_CONTENTS_URL =
    `https://api.github.com/repos/${OLD_PROJECT_OWNER}/${OLD_PROJECT_REPO}/contents/${OLD_PROJECT_PATH}?ref=${OLD_PROJECT_BRANCH}`;
  const OLD_CACHE_KEY = 'jkmap_oldproject_cache_v1';
  // Fyrir stór/stækkandi söfn (1000+ myndir) af sömu eldri verkefnum, hlaðið
  // beint upp á Cloudinary: GitHub Action les Cloudinary Admin API og EXIF
  // á netþjóni, skrifar þessa einu skrá - kortið sækir hana í stað þess að
  // lesa EXIF úr hverri mynd hjá hverjum notanda.
  const OLD_PROJECT_GEOJSON_URL = 'eldri-verkefni.geojson';
  // Handvirkt gikk fyrir Action-ið sem býr til eldri-verkefni.geojson —
  // krefst persónulegs GitHub token (Actions: write á þessu eina repo),
  // sett inn og geymt bara í þessum vafra, aldrei sent neitt annað.
  const WORKFLOW_DISPATCH_URL =
    `https://api.github.com/repos/${OLD_PROJECT_OWNER}/${OLD_PROJECT_REPO}/actions/workflows/build-old-project-geojson.yml/dispatches`;
  const GH_TOKEN_KEY = 'jkmap_gh_token_v1';

  // Points CSV (mm/leg/guy) — same ISN93 projection as the field-registration CSV.
  const ISN93 =
    '+proj=lcc +lat_1=64.25 +lat_2=65.75 +lat_0=65 +lon_0=-19 +x_0=500000 +y_0=500000 +ellps=GRS80 +units=m +no_defs +type=crs';
  const POINTS_CACHE_KEY = 'jkmap_csv_points_v1';
  const SHAPE_CACHE_KEY = 'jkmap_shape_layers_v1';

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  /** @type {Map<string, {filename:string, path:string, sha:string, lat:number|null, lon:number|null, date:string|null, heading:number|null, invalid?:boolean}>} */
  let photoCache = loadCache();
  /** @type {Map<string, L.Marker>} */
  const markersByFilename = new Map();
  /** Sjálfstæð "eldri verkefni" myndasöfnun — sami háttur og photoCache. */
  let oldPhotoCache = loadCacheFrom(OLD_CACHE_KEY);
  const oldMarkers = new Map();
  let userLocation = null; // { lat, lon, accuracy }
  let userLocationMarker = null;
  let userAccuracyCircle = null;
  let visiblePhotos = []; // photos currently passing the search/date filters
  let currentPoints = []; // last-imported CSV points, kept for the legend
  const importedShapes = []; // { id, name, color, layer } for the legend + color editing
  let shapeIdCounter = 0;

  // ---------------------------------------------------------------------
  // localStorage cache helpers
  // ---------------------------------------------------------------------
  function loadCacheFrom(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return new Map();
      const obj = JSON.parse(raw);
      return new Map(Object.entries(obj));
    } catch (err) {
      console.warn(`Could not read cache "${key}", starting empty.`, err);
      return new Map();
    }
  }

  function saveCacheTo(key, cache) {
    try {
      localStorage.setItem(key, JSON.stringify(Object.fromEntries(cache)));
    } catch (err) {
      console.warn(`Could not persist cache "${key}" (storage full/blocked?).`, err);
    }
  }

  function loadCache() {
    return loadCacheFrom(CACHE_KEY);
  }

  function saveCache() {
    saveCacheTo(CACHE_KEY, photoCache);
  }

  // ---------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function formatDistance(m) {
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(1)} km`;
  }

  function rawUrl(relPath) {
    return `${RAW_BASE}/${relPath}`;
  }

  // Cloudinary-myndir bera sína eigin fullu slóð (imageUrl); eldri myndir eru
  // sóttar af GitHub út frá path-inu eins og áður.
  function photoImageUrl(photo) {
    return photo.imageUrl || rawUrl(photo.path);
  }

  function isIOS() {
    return (
      /iP(hone|od|ad)/.test(navigator.platform) ||
      (navigator.userAgent.includes('Mac') && navigator.maxTouchPoints > 1)
    );
  }

  function setStatus(text) {
    document.getElementById('status-bar').textContent = text;
  }

  // ---------------------------------------------------------------------
  // Map + clustering setup
  // ---------------------------------------------------------------------
  const map = L.map('map', { zoomControl: true }).setView([64.9631, -19.0208], 6); // Iceland default

  const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const esriLayer = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: 'Loftmynd &copy; Esri, Maxar, Earthstar Geographics' }
  );

  // Shapefile/GeoJSON lag er alltaf sýnilegt (ekki í layer-control) og alltaf
  // undir punktunum — bætt við mapinu fyrst svo það lendi neðst í teiknunarröðinni.
  const shapeLayer = L.layerGroup();
  map.addLayer(shapeLayer);

  const clusterGroup = L.markerClusterGroup({
    maxClusterRadius: 60,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
  });
  map.addLayer(clusterGroup);

  const pointsLayer = L.layerGroup();
  map.addLayer(pointsLayer);

  const oldPhotosLayer = L.markerClusterGroup({
    maxClusterRadius: 60,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
  });
  map.addLayer(oldPhotosLayer);

  L.control.layers(
    { 'Kort (OSM)': osmLayer, 'Loftmynd (Esri)': esriLayer },
    { 'Myndir': clusterGroup, 'Punktar (CSV)': pointsLayer, 'Eldri verkefni': oldPhotosLayer },
    { position: 'topright' }
  ).addTo(map);

  function updateLabelVisibility() {
    const show = map.getZoom() >= LABEL_ZOOM_THRESHOLD;
    document.body.classList.toggle('show-labels', show);
  }
  map.on('zoomend', updateLabelVisibility);

  // ---------------------------------------------------------------------
  // Marker construction
  // ---------------------------------------------------------------------
  function photoIcon(heading) {
    const arrow =
      typeof heading === 'number'
        ? `<div class="photo-marker-arrow" style="transform: rotate(${heading}deg)"></div>`
        : '';
    return L.divIcon({
      className: 'photo-marker-wrap',
      html: `<div class="photo-marker">${arrow}<div class="photo-marker-dot"></div></div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
      popupAnchor: [0, -11],
    });
  }

  function buildPopupHtml(photo) {
    const imgUrl = photoImageUrl(photo);
    const dateHtml = photo.date ? new Date(photo.date).toLocaleString('is-IS') : 'Óþekkt dagsetning';
    const distanceHtml = userLocation
      ? `<div class="popup-distance">Fjarlægð: ${formatDistance(
          haversineMeters(userLocation.lat, userLocation.lon, photo.lat, photo.lon)
        )}</div>`
      : '';
    return `
      <div class="popup-content">
        <img class="popup-thumb" src="${imgUrl}" alt="${escapeHtml(photo.filename)}"
             onclick="window.__jkmap.openLightbox('${imgUrl.replace(/'/g, "\\'")}', '${escapeHtml(photo.filename).replace(/'/g, "\\'")}')" />
        <div class="popup-filename">${escapeHtml(photo.filename)}</div>
        <div class="popup-date">${dateHtml}</div>
        <div class="popup-coords">${photo.lat.toFixed(6)}, ${photo.lon.toFixed(6)}</div>
        ${distanceHtml}
        <button class="btn popup-navigate" type="button"
                onclick="window.__jkmap.navigateTo(${photo.lat}, ${photo.lon})">🧭 Navigate</button>
      </div>`;
  }

  function createOrUpdateMarker(photo, markerMap) {
    if (photo.lat == null || photo.lon == null) return null;

    let marker = markerMap.get(photo.id);
    if (!marker) {
      marker = L.marker([photo.lat, photo.lon], { icon: photoIcon(photo.heading) });
      marker.bindTooltip(photo.filename, {
        permanent: true,
        direction: 'top',
        offset: [0, -14],
        className: 'photo-label',
      });
      marker.bindPopup(() => buildPopupHtml(photo), { maxWidth: 260 });
      markerMap.set(photo.id, marker);
    } else {
      marker.setLatLng([photo.lat, photo.lon]);
      marker.setIcon(photoIcon(photo.heading));
      marker.setTooltipContent(photo.filename);
    }
    marker.__photo = photo;
    return marker;
  }

  function rebuildMarkersFromCache() {
    markersByFilename.forEach((marker, id) => {
      if (!photoCache.has(id) || photoCache.get(id).invalid) {
        markersByFilename.delete(id);
      }
    });

    photoCache.forEach((photo) => {
      if (photo.invalid || photo.lat == null || photo.lon == null) return;
      createOrUpdateMarker(photo, markersByFilename);
    });

    applyFilters();
    renderLegend();
  }

  // "Eldri verkefni" — óháð lag, ekki síað af leit/dagsetningu, alltaf
  // sýnt beint í eigin markerClusterGroup þegar það er virkt.
  function rebuildOldMarkers() {
    oldMarkers.forEach((marker, id) => {
      if (!oldPhotoCache.has(id) || oldPhotoCache.get(id).invalid) {
        oldMarkers.delete(id);
        oldPhotosLayer.removeLayer(marker);
      }
    });

    oldPhotoCache.forEach((photo) => {
      if (photo.invalid || photo.lat == null || photo.lon == null) return;
      const isNew = !oldMarkers.has(photo.id);
      const marker = createOrUpdateMarker(photo, oldMarkers);
      if (isNew) oldPhotosLayer.addLayer(marker);
    });

    renderLegend();
  }

  // ---------------------------------------------------------------------
  // Filters (search + date range)
  // ---------------------------------------------------------------------
  function applyFilters() {
    const q = document.getElementById('search-input').value.trim().toLowerCase();
    const fromVal = document.getElementById('date-from').value;
    const toVal = document.getElementById('date-to').value;
    const from = fromVal ? new Date(fromVal + 'T00:00:00') : null;
    const to = toVal ? new Date(toVal + 'T23:59:59') : null;

    clusterGroup.clearLayers();
    visiblePhotos = [];

    markersByFilename.forEach((marker) => {
      const photo = marker.__photo;
      const dateStr = photo.date ? new Date(photo.date).toLocaleString('is-IS') : '';
      const matchesSearch =
        !q || photo.filename.toLowerCase().includes(q) || dateStr.toLowerCase().includes(q);

      let matchesDate = true;
      if (photo.date && (from || to)) {
        const d = new Date(photo.date);
        if (from && d < from) matchesDate = false;
        if (to && d > to) matchesDate = false;
      } else if (!photo.date && (from || to)) {
        matchesDate = false;
      }

      if (matchesSearch && matchesDate) {
        clusterGroup.addLayer(marker);
        visiblePhotos.push(photo);
      }
    });

    setStatus(`${visiblePhotos.length} af ${markersByFilename.size} myndum sýndar.`);
    updateDownloadButton();
  }

  document.getElementById('search-input').addEventListener('input', applyFilters);
  document.getElementById('date-from').addEventListener('change', applyFilters);
  document.getElementById('date-to').addEventListener('change', applyFilters);
  document.getElementById('clear-filters-btn').addEventListener('click', () => {
    document.getElementById('search-input').value = '';
    document.getElementById('date-from').value = '';
    document.getElementById('date-to').value = '';
    applyFilters();
  });

  // ---------------------------------------------------------------------
  // Legend — photos, point types in use, and one row per imported shape
  // layer with a color swatch the user can change live.
  // ---------------------------------------------------------------------
  function renderLegend() {
    const el = document.getElementById('legend');
    const sections = [];

    if (markersByFilename.size > 0) {
      sections.push(`
        <div class="legend-section">
          <h3>Myndir</h3>
          <div class="legend-row"><span class="legend-swatch" style="background:var(--photo)"></span><span class="legend-label">Ljósmynd</span></div>
        </div>`);
    }

    if (oldMarkers.size > 0) {
      sections.push(`
        <div class="legend-section">
          <h3>Eldri verkefni</h3>
          <div class="legend-row"><span class="legend-swatch" style="background:var(--photo)"></span><span class="legend-label">Ljósmynd (${oldMarkers.size})</span></div>
        </div>`);
    }

    const typesInUse = new Set(currentPoints.map((p) => p.tegund || ''));
    if (typesInUse.size > 0) {
      const rows = [];
      if (typesInUse.has('mm')) rows.push(['#FA0000', 'mm — mastramiðja']);
      if (typesInUse.has('leg')) rows.push(['#3ecf8e', 'leg — leggur']);
      if (typesInUse.has('guy')) rows.push(['#9b59d0', 'guy — stag']);
      if (typesInUse.has('')) rows.push(['#2b7de9', 'Punktur (án tegundar)']);
      sections.push(`
        <div class="legend-section">
          <h3>Punktar</h3>
          ${rows.map(([color, label]) => `
            <div class="legend-row"><span class="legend-swatch" style="background:${color}"></span><span class="legend-label">${escapeHtml(label)}</span></div>
          `).join('')}
        </div>`);
    }

    if (importedShapes.length > 0) {
      sections.push(`
        <div class="legend-section">
          <h3>Lög</h3>
          ${importedShapes.map((s) => `
            <div class="legend-row">
              <input type="color" class="legend-color-input" value="${s.color}" data-shape-id="${s.id}" title="Breyta lit" />
              <span class="legend-label">${escapeHtml(s.name)}</span>
            </div>
          `).join('')}
        </div>`);
    }

    if (!sections.length) {
      el.innerHTML = '';
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';
    el.innerHTML = `<h3>Skýring</h3>${sections.join('')}`;

    el.querySelectorAll('.legend-color-input').forEach((input) => {
      input.addEventListener('input', () => {
        const id = Number(input.dataset.shapeId);
        const shape = importedShapes.find((s) => s.id === id);
        if (!shape) return;
        shape.color = input.value;
        shape.layer.setStyle({ color: shape.color, fillColor: shape.color });
        persistShapeColors();
      });
    });
  }

  // ---------------------------------------------------------------------
  // Download visible photos as a .zip
  // ---------------------------------------------------------------------
  function updateDownloadButton() {
    const btn = document.getElementById('download-btn');
    btn.disabled = visiblePhotos.length === 0;
    btn.textContent = visiblePhotos.length > 0 ? `⬇ Sækja myndir (${visiblePhotos.length})` : '⬇ Sækja myndir';
  }

  async function downloadVisiblePhotos() {
    if (!visiblePhotos.length) return;
    const btn = document.getElementById('download-btn');
    btn.disabled = true;
    const zip = new JSZip();
    let done = 0;

    try {
      for (const photo of visiblePhotos) {
        setStatus(`Sæki myndir fyrir niðurhal: ${done}/${visiblePhotos.length}…`);
        try {
          const res = await fetch(photoImageUrl(photo));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          zip.file(photo.filename, await res.blob());
        } catch (err) {
          console.warn(`Sleppti ${photo.filename} í niðurhali:`, err);
        }
        done++;
      }

      setStatus('Pakka myndum saman…');
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `jardkonnun-myndir-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus(`Niðurhal tilbúið: ${done} myndir.`);
    } finally {
      updateDownloadButton();
    }
  }

  document.getElementById('download-btn').addEventListener('click', downloadVisiblePhotos);

  // ---------------------------------------------------------------------
  // Initial load: prebuilt photos.geojson (fast path, built by GitHub Action)
  // ---------------------------------------------------------------------
  async function loadPrebuiltGeojson() {
    try {
      const res = await fetch(`${GEOJSON_URL}?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const geojson = await res.json();
      let added = 0;
      for (const feature of geojson.features || []) {
        const props = feature.properties || {};
        const [lon, lat] = feature.geometry.coordinates;
        const existing = photoCache.get(props.filename);
        if (existing && existing.sha === props.sha) continue; // already have this exact version
        photoCache.set(props.filename, {
          id: props.filename,
          filename: props.filename,
          path: props.path,
          sha: props.sha,
          lat,
          lon,
          date: props.date,
          heading: props.heading,
        });
        added++;
      }
      saveCache();
      return { ok: true, added, total: (geojson.features || []).length };
    } catch (err) {
      console.warn('Could not load photos.geojson (Action may not have run yet).', err);
      return { ok: false };
    }
  }

  // ---------------------------------------------------------------------
  // Sameiginlegt EXIF-lestur fyrir bæði GitHub- og Cloudinary-myndir.
  // Cloudinary-upphalið notar núna resource_type "raw" svo GPS-EXIF sem er
  // skrifað inn í myndina á símanum (buildExifSegment) helst óskert — sama
  // EXIF-lestur virkar því fyrir báðar myndaleiðir. Myndir sem forritið
  // sjálft tekur skrifa dagsetningu í staðlaða "DateTime" merkið (0x0132),
  // ekki DateTimeOriginal, svo það er tekið með í leitinni.
  // ---------------------------------------------------------------------
  async function readExifFromBuffer(buffer) {
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

  // ---------------------------------------------------------------------
  // Cloudinary-myndir — lesnar úr "Ljósmynd" dálki miðlægu CSV skráarinnar.
  // GPS-EXIF er lesið beint úr myndinni eins og fyrir GitHub-myndir; hnit
  // punktsins (X/Y) eru bara notuð sem varaleið ef mynd reynist einhverra
  // hluta vegna EXIF-laus.
  // ---------------------------------------------------------------------
  async function loadCloudPhotosFromCsv() {
    try {
      const res = await fetch(`${CENTRAL_CSV_URL}?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const rows = parseCsvSemicolon(text);
      if (!rows.length) throw new Error('Tóm CSV-skrá');

      const header = rows[0];
      const idx = {
        x: findColIndex(header, ['x']),
        y: findColIndex(header, ['y']),
        ljosmynd: findColIndex(header, ['ljósmynd', 'ljosmynd']),
        dagsetning: findColIndex(header, ['dagsetning']),
      };
      if (idx.x === -1 || idx.y === -1 || idx.ljosmynd === -1) {
        throw new Error('Fann ekki X/Y/Ljósmynd dálka í miðlægu CSV skránni');
      }

      const newRefs = [];
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const csvVal = (row[idx.ljosmynd] || '').trim();
        if (!csvVal) continue;

        const cloudRefs = csvVal
          .split(',')
          .map((s) => s.trim())
          .filter((ref) => /^https?:\/\//i.test(ref) && !photoCache.has(ref));
        if (!cloudRefs.length) continue; // bare GitHub filenames are handled by the EXIF path

        const x = parseFloat(row[idx.x]);
        const y = parseFloat(row[idx.y]);
        const [fallbackLon, fallbackLat] =
          isFinite(x) && isFinite(y) ? proj4(ISN93, 'EPSG:4326', [x, y]) : [null, null];
        const fallbackDate = idx.dagsetning !== -1 ? (row[idx.dagsetning] || '').trim() || null : null;

        cloudRefs.forEach((url) => newRefs.push({ url, fallbackLat, fallbackLon, fallbackDate }));
      }

      let added = 0;
      await runWithConcurrency(newRefs, REFRESH_CONCURRENCY, async (ref) => {
        const filename = decodeURIComponent(ref.url.split('/').pop().split('?')[0]) || ref.url;
        let exif = { lat: null, lon: null, date: null, heading: null };
        try {
          const imgRes = await fetch(ref.url);
          if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
          exif = await readExifFromBuffer(await imgRes.arrayBuffer());
        } catch (err) {
          console.warn(`Gat ekki lesið EXIF úr ${filename}, nota hnit punktsins í staðinn:`, err);
        }
        photoCache.set(ref.url, {
          id: ref.url,
          filename,
          path: null,
          imageUrl: ref.url,
          sha: ref.url,
          lat: exif.lat ?? ref.fallbackLat,
          lon: exif.lon ?? ref.fallbackLon,
          date: exif.date || ref.fallbackDate,
          heading: exif.heading,
        });
        added++;
      });

      saveCache();
      return { ok: true, added };
    } catch (err) {
      console.warn('Gat ekki sótt Cloudinary-myndir úr miðlægu CSV skránni.', err);
      return { ok: false };
    }
  }

  // ---------------------------------------------------------------------
  // Refresh: talk to GitHub API directly, read EXIF client-side, only for
  // files whose sha isn't already in the cache.
  // ---------------------------------------------------------------------
  async function fetchFolderListing() {
    const res = await fetch(CONTENTS_API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (res.status === 404) {
      // Tóm/horfin mappa - git geymir ekki tómar möppur, svo GitHub API
      // skilar 404 um leið og síðustu skránni er eytt. Það er ekki villa,
      // bara "engar eldri myndir eftir" (allt komið á Cloudinary).
      return [];
    }
    if (!res.ok) {
      throw new Error(`GitHub API villa: HTTP ${res.status}`);
    }
    const items = await res.json();
    return items.filter((it) => it.type === 'file' && VALID_EXT.test(it.name));
  }

  async function readExifForFile(item) {
    const res = await fetch(item.download_url);
    if (!res.ok) throw new Error(`Gat ekki sótt ${item.name}: HTTP ${res.status}`);
    const exif = await readExifFromBuffer(await res.arrayBuffer());

    if (exif.lat == null || exif.lon == null) {
      return {
        id: item.name,
        filename: item.name,
        path: `${IMAGES_PATH}/${item.name}`,
        sha: item.sha,
        lat: null,
        lon: null,
        date: null,
        heading: null,
        invalid: true,
      };
    }

    return {
      id: item.name,
      filename: item.name,
      path: `${IMAGES_PATH}/${item.name}`,
      sha: item.sha,
      lat: exif.lat,
      lon: exif.lon,
      date: exif.date,
      heading: exif.heading,
    };
  }

  async function runWithConcurrency(items, limit, worker) {
    const results = [];
    let index = 0;
    async function next() {
      while (index < items.length) {
        const i = index++;
        results[i] = await worker(items[i], i);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
    return results;
  }

  async function refreshPhotos() {
    const btn = document.getElementById('refresh-btn');
    btn.disabled = true;
    setStatus('Sæki lista yfir myndir…');

    try {
      const listing = await fetchFolderListing();
      const liveNames = new Set(listing.map((it) => it.name));

      // Drop cache entries for legacy GitHub files no longer in the repo.
      // Cloudinary entries (imageUrl set) aren't part of this listing at all.
      Array.from(photoCache.entries()).forEach(([id, photo]) => {
        if (!photo.imageUrl && !liveNames.has(id)) photoCache.delete(id);
      });

      const toProcess = listing.filter((it) => {
        const cached = photoCache.get(it.name);
        return !cached || cached.sha !== it.sha;
      });

      let done = 0;
      await runWithConcurrency(toProcess, REFRESH_CONCURRENCY, async (item) => {
        try {
          const photo = await readExifForFile(item);
          photoCache.set(photo.id, photo);
        } catch (err) {
          console.warn(`Villa við að lesa ${item.name}:`, err);
        }
        done++;
        setStatus(`Les EXIF: ${done}/${toProcess.length} nýjar myndir…`);
      });

      const cloudResult = await loadCloudPhotosFromCsv();
      const oldGeoResult = await loadOldProjectGeojson();
      const oldResult = await refreshOldProjectPhotos();
      oldResult.added = (oldResult.added || 0) + oldGeoResult.added;

      saveCache();
      rebuildMarkersFromCache();
      const cloudNote = cloudResult.ok ? `, ${cloudResult.added} nýjar úr Cloudinary` : '';
      const oldNote = oldResult.added ? `, ${oldResult.added} nýjar úr eldri verkefnum` : '';
      setStatus(`Uppfært kl. ${new Date().toLocaleTimeString('is-IS')} — ${toProcess.length} nýjar/breyttar úr myndir/${cloudNote}${oldNote}, ${photoCache.size} samtals.`);
    } catch (err) {
      console.error(err);
      setStatus(`Villa við endurhleðslu: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  }

  document.getElementById('refresh-btn').addEventListener('click', refreshPhotos);

  // ---------------------------------------------------------------------
  // "Eldri verkefni" — óháð myndamappa, engin CSV-tenging, sama EXIF-GPS
  // aðferð og fyrir myndir/. Keyrir sjálfkrafa við ræsingu og með
  // "🔄 Refresh Photos" hnappinum, ofan á aðal-myndaleitina.
  //
  // Tvær gagnaleiðir sem báðar skrifa í sama oldPhotoCache:
  //  1) Forreiknuð eldri-verkefni.geojson (GitHub Action + Cloudinary,
  //     hentar fyrir stór/stækkandi söfn - engin EXIF-lesning í vafra).
  //  2) Bein GitHub-möppulisting + EXIF-lestur í vafra (hentar fyrir
  //     fáar myndir settar beint inn í eldri-verkefni/ í þessu repo-i).
  // ---------------------------------------------------------------------
  async function loadOldProjectGeojson() {
    try {
      const res = await fetch(`${OLD_PROJECT_GEOJSON_URL}?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const geojson = await res.json();
      let added = 0;
      for (const feature of geojson.features || []) {
        const props = feature.properties || {};
        const [lon, lat] = feature.geometry.coordinates;
        const id = props.publicId || props.url;
        const existing = oldPhotoCache.get(id);
        if (existing && existing.sha === props.version) continue;
        oldPhotoCache.set(id, {
          id,
          filename: props.filename,
          imageUrl: props.url,
          sha: props.version,
          source: 'cloudinary',
          lat,
          lon,
          date: props.date,
          heading: props.heading,
        });
        added++;
      }
      saveCacheTo(OLD_CACHE_KEY, oldPhotoCache);
      return { ok: true, added };
    } catch (err) {
      console.warn('Gat ekki sótt eldri-verkefni.geojson (Action gæti ekki hafa keyrt enn).', err);
      return { ok: false, added: 0 };
    }
  }

  async function fetchOldProjectListing() {
    const res = await fetch(OLD_PROJECT_CONTENTS_URL, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (res.status === 404) return []; // mappan er ekki til (enn) - ekki villa
    if (!res.ok) {
      throw new Error(`GitHub API villa: HTTP ${res.status}`);
    }
    const items = await res.json();
    return items.filter((it) => it.type === 'file' && VALID_EXT.test(it.name));
  }

  async function refreshOldProjectPhotos() {
    try {
      const listing = await fetchOldProjectListing();
      const liveNames = new Set(listing.map((it) => it.name));

      // Aðeins hreinsa GitHub-upprunnar færslur héðan - Cloudinary-færslur
      // (úr loadOldProjectGeojson) eiga ekkert erindi í þessa möppulistun
      // og mega ekki hverfa bara af því þær eru ekki GitHub-skrár.
      Array.from(oldPhotoCache.entries()).forEach(([id, photo]) => {
        if (photo.source === 'github' && !liveNames.has(id)) oldPhotoCache.delete(id);
      });

      const toProcess = listing.filter((it) => {
        const cached = oldPhotoCache.get(it.name);
        return !cached || cached.sha !== it.sha;
      });

      await runWithConcurrency(toProcess, REFRESH_CONCURRENCY, async (item) => {
        try {
          const res = await fetch(item.download_url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const exif = await readExifFromBuffer(await res.arrayBuffer());
          oldPhotoCache.set(item.name, {
            id: item.name,
            filename: item.name,
            imageUrl: `${OLD_PROJECT_RAW_BASE}/${OLD_PROJECT_PATH}/${item.name}`,
            sha: item.sha,
            source: 'github',
            lat: exif.lat,
            lon: exif.lon,
            date: exif.date,
            heading: exif.heading,
            invalid: exif.lat == null,
          });
        } catch (err) {
          console.warn(`Villa við að lesa ${item.name} (eldri verkefni):`, err);
        }
      });

      saveCacheTo(OLD_CACHE_KEY, oldPhotoCache);
      rebuildOldMarkers();
      return { ok: true, added: toProcess.length };
    } catch (err) {
      console.warn('Gat ekki sótt eldri-verkefni myndir.', err);
      return { ok: false, added: 0 };
    }
  }

  // ---------------------------------------------------------------------
  // My Location
  // ---------------------------------------------------------------------
  function locateUser() {
    if (!navigator.geolocation) {
      alert('Vafrinn styður ekki staðsetningu.');
      return;
    }
    const btn = document.getElementById('locate-btn');
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        userLocation = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        };

        if (!userLocationMarker) {
          userLocationMarker = L.marker([userLocation.lat, userLocation.lon], {
            icon: L.divIcon({
              className: 'user-location-wrap',
              html: '<div class="user-location-dot"></div>',
              iconSize: [16, 16],
              iconAnchor: [8, 8],
            }),
            zIndexOffset: 1000,
          }).addTo(map);
          userAccuracyCircle = L.circle([userLocation.lat, userLocation.lon], {
            radius: userLocation.accuracy,
            color: '#2b7de9',
            fillColor: '#2b7de9',
            fillOpacity: 0.15,
            weight: 1,
          }).addTo(map);
        } else {
          userLocationMarker.setLatLng([userLocation.lat, userLocation.lon]);
          userAccuracyCircle.setLatLng([userLocation.lat, userLocation.lon]);
          userAccuracyCircle.setRadius(userLocation.accuracy);
        }

        map.setView([userLocation.lat, userLocation.lon], Math.max(map.getZoom(), 15));
        btn.disabled = false;
      },
      (err) => {
        alert(`Gat ekki nálgast staðsetningu: ${err.message}`);
        btn.disabled = false;
      },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }

  document.getElementById('locate-btn').addEventListener('click', locateUser);

  // ---------------------------------------------------------------------
  // Hreinsa gögn — hendir öllu staðbundnu vistuðu ástandi (myndir, punktar,
  // lög) og endurhleður síðuna hreina. Gagnlegt þegar gömul localStorage-
  // gögn úr fyrri heimsóknum flækjast fyrir (t.d. eftir kóðabreytingu).
  // ---------------------------------------------------------------------
  document.getElementById('clear-cache-btn').addEventListener('click', () => {
    if (!confirm('Hreinsa öll vistuð gögn (myndir, punktar, lög) úr þessum vafra og endurhlaða?')) return;
    [CACHE_KEY, POINTS_CACHE_KEY, SHAPE_CACHE_KEY, OLD_CACHE_KEY].forEach((key) => {
      try {
        localStorage.removeItem(key);
      } catch (err) {
        console.warn(`Gat ekki hreinsað ${key}.`, err);
      }
    });
    location.reload();
  });

  // ---------------------------------------------------------------------
  // Keyra "eldri-verkefni.geojson" Action-ið beint úr kortinu.
  // GitHub leyfir aldrei að ræsa Actions án auðkenningar, svo þetta krefst
  // persónulegs access token frá þeim sem ýtir á hnappinn - hann er geymdur
  // eingöngu í localStorage í þeirra eigin vafra, aldrei sendur neitt nema
  // beint til GitHub. Búðu til fine-grained PAT með "Actions: write"
  // heimild á nonni123/JarMyndir eingöngu.
  // ---------------------------------------------------------------------
  async function runOldProjectAction() {
    let token = localStorage.getItem(GH_TOKEN_KEY);
    if (!token) {
      token = prompt(
        'GitHub personal access token vantar til að keyra Action-ið.\n' +
        'Búðu til "fine-grained" token á github.com/settings/tokens með\n' +
        '"Actions: write" heimild á nonni123/JarMyndir eingöngu.\n' +
        'Það vistast bara í þessum vafra.'
      );
      if (!token) return;
      try {
        localStorage.setItem(GH_TOKEN_KEY, token);
      } catch (err) {
        console.warn('Gat ekki vistað token.', err);
      }
    }

    const btn = document.getElementById('run-action-btn');
    btn.disabled = true;
    setStatus('Ræsi Action fyrir eldri-verkefni.geojson…');
    try {
      const res = await fetch(WORKFLOW_DISPATCH_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: OLD_PROJECT_BRANCH }),
      });
      if (res.status === 204) {
        setStatus('Action ræst — tekur yfirleitt ~30-60 sek. Ýttu á "🔄 Refresh Photos" á eftir.');
      } else if (res.status === 401 || res.status === 403) {
        localStorage.removeItem(GH_TOKEN_KEY);
        throw new Error('Token hafnað (rangt eða vantar heimild) — reyndu aftur með nýtt token.');
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      console.error(err);
      setStatus(`Villa við að ræsa Action: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  }

  document.getElementById('run-action-btn').addEventListener('click', runOldProjectAction);

  // ---------------------------------------------------------------------
  // Lightbox + navigation — exposed for inline onclick handlers in popups.
  // ---------------------------------------------------------------------
  function openLightbox(url, filename) {
    document.getElementById('lightbox-img').src = url;
    document.getElementById('lightbox-caption').textContent = filename;
    document.getElementById('lightbox').classList.remove('hidden');
  }

  function closeLightbox() {
    document.getElementById('lightbox').classList.add('hidden');
    document.getElementById('lightbox-img').src = '';
  }

  function navigateTo(lat, lon) {
    const url = isIOS()
      ? `https://maps.apple.com/?daddr=${lat},${lon}&dirflg=d`
      : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
    window.open(url, '_blank', 'noopener');
  }

  document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
  document.getElementById('lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLightbox();
  });

  window.__jkmap = { openLightbox, navigateTo };

  // ---------------------------------------------------------------------
  // Punktar (CSV) — sama snið og miðlæga skráningar-CSV skráin
  // (semikommu-aðskilið, ISN93 X/Y hnit), með valfrjálsum "tegund" dálki
  // (mm/leg/guy) sem stýrir lit/stærð, alveg eins og í aðal-appinu.
  // ---------------------------------------------------------------------
  const pointMarkers = [];

  function parseCsvSemicolon(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else { inQuotes = false; }
        } else {
          cell += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ';') {
        row.push(cell); cell = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = ''; rows.push(row); row = [];
      } else {
        cell += ch;
      }
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  function findColIndex(header, names) {
    const lower = header.map((h) => (h || '').trim().toLowerCase());
    for (const name of names) {
      const idx = lower.indexOf(name);
      if (idx !== -1) return idx;
    }
    return -1;
  }

  function pointTypeStyle(tegund) {
    if (tegund === 'mm') return { radius: 9, fillColor: '#FA0000' };
    if (tegund === 'leg') return { radius: 4, fillColor: '#3ecf8e' };
    if (tegund === 'guy') return { radius: 4, fillColor: '#9b59d0' };
    return { radius: 6, fillColor: '#2b7de9' };
  }

  function buildPointPopupHtml(p) {
    const distanceHtml = userLocation
      ? `<div class="popup-distance">Fjarlægð: ${formatDistance(
          haversineMeters(userLocation.lat, userLocation.lon, p.lat, p.lon)
        )}</div>`
      : '';
    return `
      <div class="popup-content">
        <div class="popup-filename">${escapeHtml(p.nafn || p.nr || p.fid)}</div>
        ${p.gerd ? `<div class="popup-date">${escapeHtml(p.gerd)}${p.ng ? ' · ' + escapeHtml(p.ng) : ''}</div>` : ''}
        ${p.tegund ? `<div class="popup-date">Tegund: ${escapeHtml(p.tegund)}</div>` : ''}
        <div class="popup-coords">${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}</div>
        ${distanceHtml}
        <button class="btn popup-navigate" type="button"
                onclick="window.__jkmap.navigateTo(${p.lat}, ${p.lon})">🧭 Navigate</button>
      </div>`;
  }

  function renderCsvPoints(points) {
    pointsLayer.clearLayers();
    pointMarkers.length = 0;
    currentPoints = points;

    points.forEach((p) => {
      const style = pointTypeStyle(p.tegund);
      const marker = L.circleMarker([p.lat, p.lon], {
        radius: style.radius,
        color: '#fff',
        weight: 1.5,
        fillColor: style.fillColor,
        fillOpacity: 0.95,
      });
      marker.bindPopup(() => buildPointPopupHtml(p), { maxWidth: 260 });
      if (!p.tegund || p.tegund === 'mm') {
        marker.bindTooltip(p.nr || p.nafn || p.fid, {
          permanent: true,
          direction: 'top',
          offset: [0, -8],
          className: 'point-label',
        });
      }
      marker.addTo(pointsLayer);
      pointMarkers.push(marker);
    });

    setStatus(`${points.length} punktar hlaðnir úr CSV.`);
    renderLegend();

    if (points.length > 0) {
      const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lon]));
      map.fitBounds(bounds.pad(0.2), { maxZoom: 16 });
    }
  }

  function parsePointsCsv(text) {
    const rows = parseCsvSemicolon(text);
    if (!rows.length) throw new Error('Tóm CSV-skrá');
    const header = rows[0];
    const idx = {
      fid: findColIndex(header, ['fid']),
      nr: findColIndex(header, ['nr.', 'nr']),
      nafn: findColIndex(header, ['nafn', 'heiti', 'name']),
      gerd: findColIndex(header, ['gerð', 'gerd']),
      ng: findColIndex(header, ['ng']),
      x: findColIndex(header, ['x']),
      y: findColIndex(header, ['y']),
      tegund: findColIndex(header, ['tegund', 'type']),
    };
    if (idx.x === -1 || idx.y === -1) {
      throw new Error('Fann ekki X/Y dálka í CSV-skránni');
    }

    const points = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const x = parseFloat(row[idx.x]);
      const y = parseFloat(row[idx.y]);
      if (!isFinite(x) || !isFinite(y)) continue;
      const [lon, lat] = proj4(ISN93, 'EPSG:4326', [x, y]);
      points.push({
        fid: idx.fid !== -1 ? (row[idx.fid] || '').trim() : String(r),
        nr: idx.nr !== -1 ? (row[idx.nr] || '').trim() : '',
        nafn: idx.nafn !== -1 ? (row[idx.nafn] || '').trim() : '',
        gerd: idx.gerd !== -1 ? (row[idx.gerd] || '').trim() : '',
        ng: idx.ng !== -1 ? (row[idx.ng] || '').trim() : '',
        tegund: idx.tegund !== -1 ? (row[idx.tegund] || '').trim().toLowerCase() : '',
        lat,
        lon,
      });
    }
    return points;
  }

  document.getElementById('points-btn').addEventListener('click', () => {
    document.getElementById('points-input').click();
  });

  document.getElementById('points-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    file
      .text()
      .then((text) => {
        const points = parsePointsCsv(text);
        renderCsvPoints(points);
        try {
          localStorage.setItem(POINTS_CACHE_KEY, text);
        } catch (err) {
          console.warn('Gat ekki vistað punkta-CSV í localStorage.', err);
        }
      })
      .catch((err) => {
        console.error(err);
        setStatus(`Villa við lestur punkta-CSV: ${err.message}`);
      });
  });

  function loadCachedPoints() {
    try {
      const text = localStorage.getItem(POINTS_CACHE_KEY);
      if (!text) return;
      renderCsvPoints(parsePointsCsv(text));
    } catch (err) {
      console.warn('Gat ekki endurhlaðið vistaða punkta-CSV.', err);
    }
  }

  // ---------------------------------------------------------------------
  // Shapefile / GeoJSON lag — alltaf sýnilegt, ekki hægt að velja/fela á
  // kortinu, og alltaf teiknað undir punktunum (sjá shapeLayer ofar).
  // ---------------------------------------------------------------------
  function reprojectIsn93IfNeeded(geojson) {
    function walk(coords, fn) {
      if (typeof coords[0] === 'number') return fn(coords);
      return coords.map((c) => walk(c, fn));
    }
    const feats = geojson.features || [];
    let needsReproject = false;
    for (const f of feats) {
      const g = f.geometry;
      if (!g || !g.coordinates) continue;
      walk(g.coordinates, (pt) => {
        if (Math.abs(pt[0]) > 180 || Math.abs(pt[1]) > 90) needsReproject = true;
        return pt;
      });
      break;
    }
    if (!needsReproject) return geojson;
    feats.forEach((f) => {
      const g = f.geometry;
      if (!g || !g.coordinates) return;
      g.coordinates = walk(g.coordinates, (pt) => proj4(ISN93, 'EPSG:4326', [pt[0], pt[1]]));
    });
    return geojson;
  }

  const DEFAULT_SHAPE_COLOR = '#6b7280';

  function addShapeLayer(name, geojson, color) {
    const shapeColor = color || DEFAULT_SHAPE_COLOR;
    const layer = L.geoJSON(reprojectIsn93IfNeeded(geojson), {
      style: { color: shapeColor, weight: 2, opacity: 0.85 },
      pointToLayer: (f, latlng) =>
        L.circleMarker(latlng, { radius: 4, color: '#fff', weight: 1, fillColor: shapeColor, fillOpacity: 0.9 }),
      onEachFeature: (feature, fl) => {
        const props = feature.properties || {};
        const keys = Object.keys(props).filter((k) => props[k] !== null && props[k] !== '');
        if (!keys.length) return;
        fl.bindPopup(keys.map((k) => `<b>${escapeHtml(k)}:</b> ${escapeHtml(props[k])}`).join('<br>'));
      },
    });
    layer.addTo(shapeLayer);
    importedShapes.push({ id: shapeIdCounter++, name, color: shapeColor, layer });
    renderLegend();
  }

  function persistShapeColors() {
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(SHAPE_CACHE_KEY)) || [];
    } catch (err) {
      saved = [];
    }
    // Colors are matched back up by position on load, so keep the stored
    // geojson but refresh every color from current legend state.
    saved.forEach((s, i) => {
      if (importedShapes[i]) s.color = importedShapes[i].color;
    });
    try {
      localStorage.setItem(SHAPE_CACHE_KEY, JSON.stringify(saved));
    } catch (err) {
      console.warn('Gat ekki vistað lit á lagi (localStorage full?).', err);
    }
  }

  function loadCachedShapes() {
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(SHAPE_CACHE_KEY)) || [];
    } catch (err) {
      saved = [];
    }
    saved.forEach((s) => addShapeLayer(s.name, s.geojson, s.color));
  }

  function saveShape(name, geojson, color) {
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(SHAPE_CACHE_KEY)) || [];
    } catch (err) {
      saved = [];
    }
    saved.push({ name, geojson, color });
    try {
      localStorage.setItem(SHAPE_CACHE_KEY, JSON.stringify(saved));
    } catch (err) {
      console.warn('Lagið birtist en rúmaðist ekki í geymslu (localStorage full?).', err);
    }
  }

  document.getElementById('shape-btn').addEventListener('click', () => {
    document.getElementById('shape-input').click();
  });

  document.getElementById('shape-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const isZip = /\.zip$/i.test(file.name);
    const name = file.name.replace(/\.(zip|geo)?json$/i, '').replace(/\.zip$/i, '');
    const parsed = isZip
      ? file.arrayBuffer().then((buf) => shp(buf))
      : file.text().then((t) => JSON.parse(t));

    parsed
      .then((result) => {
        const collections = Array.isArray(result) ? result : [result];
        collections.forEach((geojson) => {
          addShapeLayer(name, geojson, DEFAULT_SHAPE_COLOR);
          saveShape(name, geojson, DEFAULT_SHAPE_COLOR);
        });
        setStatus(`Lag flutt inn: ${name} (${collections.length} safn)`);
      })
      .catch((err) => {
        console.error(err);
        setStatus(`Villa við lestur lags: ${err.message} — er þetta zippuð shapefile eða GeoJSON?`);
      });
  });

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  updateLabelVisibility();
  loadCachedShapes(); // undirlag - alltaf fyrst svo það haldist neðst
  rebuildMarkersFromCache(); // paint whatever's already cached from a previous visit
  rebuildOldMarkers(); // paint cached "eldri verkefni" photos too
  loadCachedPoints(); // paint any previously-imported points CSV
  setStatus('Sæki myndalista…');
  Promise.all([loadPrebuiltGeojson(), loadCloudPhotosFromCsv(), loadOldProjectGeojson(), refreshOldProjectPhotos()]).then(([geoResult, cloudResult]) => {
    rebuildMarkersFromCache();
    rebuildOldMarkers(); // tryggir að bæði eldri-verkefni gagnaleiðirnar séu að fullu teiknaðar
    const addedCloud = cloudResult.ok ? cloudResult.added : 0;
    if (geoResult.ok) {
      setStatus(`${photoCache.size} myndir hlaðnar (${geoResult.added} nýjar/breyttar úr photos.geojson, ${addedCloud} úr Cloudinary).`);
    } else if (cloudResult.ok) {
      setStatus(`${photoCache.size} myndir hlaðnar (${addedCloud} úr Cloudinary). photos.geojson fannst ekki — ýttu á "🔄 Refresh Photos" fyrir eldri myndir.`);
    } else {
      setStatus('Engin gögn fundust enn — ýttu á "🔄 Refresh Photos" til að lesa myndir beint.');
    }

    if (markersByFilename.size > 0) {
      const bounds = L.latLngBounds(
        Array.from(markersByFilename.values()).map((m) => m.getLatLng())
      );
      map.fitBounds(bounds.pad(0.2), { maxZoom: 14 });
    }
  });
})();
