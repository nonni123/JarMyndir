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

  const CACHE_KEY = 'jkmap_photo_cache_v1';
  const LABEL_ZOOM_THRESHOLD = 15;
  const VALID_EXT = /\.(jpe?g)$/i;
  const REFRESH_CONCURRENCY = 4;

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  /** @type {Map<string, {filename:string, path:string, sha:string, lat:number|null, lon:number|null, date:string|null, heading:number|null, invalid?:boolean}>} */
  let photoCache = loadCache();
  /** @type {Map<string, L.Marker>} */
  const markersByFilename = new Map();
  let userLocation = null; // { lat, lon, accuracy }
  let userLocationMarker = null;
  let userAccuracyCircle = null;

  // ---------------------------------------------------------------------
  // localStorage cache helpers
  // ---------------------------------------------------------------------
  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return new Map();
      const obj = JSON.parse(raw);
      return new Map(Object.entries(obj));
    } catch (err) {
      console.warn('Could not read photo cache, starting empty.', err);
      return new Map();
    }
  }

  function saveCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(photoCache)));
    } catch (err) {
      console.warn('Could not persist photo cache (storage full/blocked?).', err);
    }
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

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const clusterGroup = L.markerClusterGroup({
    maxClusterRadius: 60,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
  });
  map.addLayer(clusterGroup);

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
    const imgUrl = rawUrl(photo.path);
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

  function createOrUpdateMarker(photo) {
    if (photo.lat == null || photo.lon == null) return null;

    let marker = markersByFilename.get(photo.filename);
    if (!marker) {
      marker = L.marker([photo.lat, photo.lon], { icon: photoIcon(photo.heading) });
      marker.bindTooltip(photo.filename, {
        permanent: true,
        direction: 'top',
        offset: [0, -14],
        className: 'photo-label',
      });
      marker.bindPopup(() => buildPopupHtml(photo), { maxWidth: 260 });
      markersByFilename.set(photo.filename, marker);
    } else {
      marker.setLatLng([photo.lat, photo.lon]);
      marker.setIcon(photoIcon(photo.heading));
      marker.setTooltipContent(photo.filename);
    }
    marker.__photo = photo;
    return marker;
  }

  function rebuildMarkersFromCache() {
    markersByFilename.forEach((marker, filename) => {
      if (!photoCache.has(filename) || photoCache.get(filename).invalid) {
        markersByFilename.delete(filename);
      }
    });

    photoCache.forEach((photo) => {
      if (photo.invalid || photo.lat == null || photo.lon == null) return;
      createOrUpdateMarker(photo);
    });

    applyFilters();
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
    let visibleCount = 0;

    markersByFilename.forEach((marker, filename) => {
      const photo = marker.__photo;
      const dateStr = photo.date ? new Date(photo.date).toLocaleString('is-IS') : '';
      const matchesSearch =
        !q || filename.toLowerCase().includes(q) || dateStr.toLowerCase().includes(q);

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
        visibleCount++;
      }
    });

    setStatus(`${visibleCount} af ${markersByFilename.size} myndum sýndar.`);
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
  // Refresh: talk to GitHub API directly, read EXIF client-side, only for
  // files whose sha isn't already in the cache.
  // ---------------------------------------------------------------------
  async function fetchFolderListing() {
    const res = await fetch(CONTENTS_API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      throw new Error(`GitHub API villa: HTTP ${res.status}`);
    }
    const items = await res.json();
    return items.filter((it) => it.type === 'file' && VALID_EXT.test(it.name));
  }

  async function readExifForFile(item) {
    const res = await fetch(item.download_url);
    if (!res.ok) throw new Error(`Gat ekki sótt ${item.name}: HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    const gps = await exifr.gps(buffer).catch(() => null);
    const tags = await exifr
      .parse(buffer, { pick: ['DateTimeOriginal', 'CreateDate', 'GPSImgDirection'] })
      .catch(() => null);

    if (!gps || typeof gps.latitude !== 'number' || typeof gps.longitude !== 'number') {
      return {
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

    const rawDate = tags?.DateTimeOriginal || tags?.CreateDate || null;
    return {
      filename: item.name,
      path: `${IMAGES_PATH}/${item.name}`,
      sha: item.sha,
      lat: gps.latitude,
      lon: gps.longitude,
      date: rawDate ? new Date(rawDate).toISOString() : null,
      heading: typeof tags?.GPSImgDirection === 'number' ? tags.GPSImgDirection : null,
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

      // Drop cache entries for files no longer in the repo.
      Array.from(photoCache.keys()).forEach((name) => {
        if (!liveNames.has(name)) photoCache.delete(name);
      });

      const toProcess = listing.filter((it) => {
        const cached = photoCache.get(it.name);
        return !cached || cached.sha !== it.sha;
      });

      if (toProcess.length === 0) {
        saveCache();
        rebuildMarkersFromCache();
        setStatus(`Engar nýjar myndir. ${photoCache.size} myndir samtals.`);
        return;
      }

      let done = 0;
      await runWithConcurrency(toProcess, REFRESH_CONCURRENCY, async (item) => {
        try {
          const photo = await readExifForFile(item);
          photoCache.set(photo.filename, photo);
        } catch (err) {
          console.warn(`Villa við að lesa ${item.name}:`, err);
        }
        done++;
        setStatus(`Les EXIF: ${done}/${toProcess.length} nýjar myndir…`);
      });

      saveCache();
      rebuildMarkersFromCache();
      setStatus(`Uppfært kl. ${new Date().toLocaleTimeString('is-IS')} — ${toProcess.length} nýjar/breyttar myndir, ${photoCache.size} samtals.`);
    } catch (err) {
      console.error(err);
      setStatus(`Villa við endurhleðslu: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  }

  document.getElementById('refresh-btn').addEventListener('click', refreshPhotos);

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
  // Boot
  // ---------------------------------------------------------------------
  updateLabelVisibility();
  rebuildMarkersFromCache(); // paint whatever's already cached from a previous visit
  setStatus('Sæki myndalista…');
  loadPrebuiltGeojson().then((result) => {
    rebuildMarkersFromCache();
    if (result.ok) {
      setStatus(`${photoCache.size} myndir hlaðnar (${result.added} nýjar/breyttar úr photos.geojson).`);
    } else {
      setStatus('photos.geojson fannst ekki enn — ýttu á "🔄 Refresh Photos" til að lesa myndir beint.');
    }

    if (markersByFilename.size > 0) {
      const bounds = L.latLngBounds(
        Array.from(markersByFilename.values()).map((m) => m.getLatLng())
      );
      map.fitBounds(bounds.pad(0.2), { maxZoom: 14 });
    }
  });
})();
