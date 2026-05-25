Chart.register(ChartDataLabels); 

let db = [];
let map, markers, userMarker;
let charts = {}; 

// Theme Initialization
const savedTheme = localStorage.getItem('theme') || 'light';
document.documentElement.setAttribute('data-theme', savedTheme);
Chart.defaults.color = savedTheme === 'dark' ? '#cbd5e1' : '#475569';

// Pagination & Performance State
let currentFilteredData = [];
let currentPage = 1;
const ITEMS_PER_PAGE = 50; 
let allTimeChartsRendered = false; // Performance flag to prevent unnecessary re-rendering
let allTimeMetrics = null;

const PH_CENTER = [12.8797, 121.7740];
const API_URL = 'https://sheetlabs.com/LA25/LIGTAS_LSDB_WEB_APIv2'; 

function init() {
    const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: 'Esri' });
    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: 'OSM' });

    map = L.map('map', { center: PH_CENTER, zoom: 5, layers: [sat], zoomControl: false });
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    const lyProvinces = L.layerGroup();
    const lyRegions = L.layerGroup();
    const lyFaults = L.layerGroup();
    markers = L.layerGroup().addTo(map);

    ['provinces', 'regions', 'faults'].forEach((key, i) => {
        const colors = ['red', 'yellow', 'green'];
        fetch(`https://raw.githubusercontent.com/Gabzrock/LIGTASAGADEWSV3/refs/heads/main/uRIL_AWS_${key === 'provinces' ? 'High' : key === 'regions' ? 'Moderate' : 'Low'}_Susceptibility.geojson`)
            .then(r => r.json())
            .then(data => L.geoJson(data, { style: { color: colors[i], fillOpacity: 0.3 } }).addTo(i === 0 ? lyProvinces : i === 1 ? lyRegions : lyFaults))
            .catch(err => console.warn(`Could not load GeoJSON layer: ${key}`, err)); // Error handling for layers
    });

    L.control.layers({ "Satellite": sat, "OSM": osm }, { "Markers": markers, "MGB-High": lyProvinces, "MGB-Med": lyRegions, "MGB-Low": lyFaults }).addTo(map);

    map.on('moveend', () => {
        const extToggle = document.getElementById('fExtent');
        if (extToggle && extToggle.checked) filter(); 
    });

    connectRegistry();
}

// --- HAMBURGER MENU & THEME TOGGLE ---
function toggleMobileMenu() {
    document.getElementById('navMenu').classList.toggle('active');
}

function closeMobileMenu() {
    document.getElementById('navMenu').classList.remove('active');
}

function toggleTheme() {
    const root = document.documentElement;
    const currentTheme = root.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    
    root.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    
    Chart.defaults.color = newTheme === 'dark' ? '#cbd5e1' : '#475569';
    
    // Force re-render of static charts to apply new theme colors
    allTimeChartsRendered = false; 
    ['coords','loc','date','time','completenessTrig','completenessCat'].forEach(id => charts['chart' + id.charAt(0).toUpperCase() + id.slice(1)]?.destroy());
    
    if(currentFilteredData.length > 0) buildCharts(currentFilteredData);
}

// --- DATA SYNC & ERROR HANDLING ---
async function connectRegistry() {
    setStatus('SYNCING DATA...', 'warning');
    try {
        const res = await fetch(API_URL);
        
        // Strict Error Handling
        if (!res.ok) throw new Error(`HTTP Error: ${res.status} ${res.statusText}`);
        
        let raw = await res.json();
        if (!Array.isArray(raw) || raw.length === 0) throw new Error("API returned an empty or invalid dataset.");

        db = raw.map(i => {
            // Safe parsing to prevent application crashes from corrupted data
            const lat = parseFloat(i.Latitude);
            const lng = parseFloat(i.Longitude);
            const yr = i.Year ? String(i.Year).trim() : (i.YYYYMMDD ? String(i.YYYYMMDD).substring(0, 4) : 'Unknown');
            
            return {
                ...i,
                lat: isNaN(lat) ? null : lat,
                lng: isNaN(lng) ? null : lng,
                deaths: parseInt(i.DEATHS) || 0,
                year: yr,
                // Performance Optimization: Pre-compile search string once (O(1) search time)
                searchStr: `${i.LSID || ''} ${i.MUNICIPALITY || ''} ${i.PROVINCE || ''} ${i.REGION || ''} ${i.LSTRIGGER || ''} ${i.LSCATEGORY || ''} ${yr}`.toLowerCase()
            };
        });

        db.sort((a, b) => new Date(b.YYYYMMDD || 0) - new Date(a.YYYYMMDD || 0));
        
        // Performance Optimization: Calculate heavy metrics only once upon initial load
        computeAllTimeMetrics();

        setStatus('SYSTEM ONLINE', 'online');
        initFilters();
        filter();
    } catch (e) {
        console.error("Critical System Failure:", e);
        setStatus('CONNECTION FAILED', 'error');
        document.getElementById('feed').innerHTML = `<div style="padding:40px; text-align:center; color:var(--danger); font-weight:bold; font-size:16px;">Failed to load system data. <br><br>Error: ${e.message} <br><br>Please try refreshing the page or check your connection.</div>`;
    }
}

// --- FILTER CONTROLS & DEBOUNCING ---
// Performance Optimization: Prevents function from firing on every keystroke
function debounce(func, timeout = 300) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => { func.apply(this, args); }, timeout);
    };
}

function toggleFilters() {
    const fc = document.getElementById('filterControls');
    fc.classList.toggle('hidden-view');
    setTimeout(() => map.invalidateSize(), 350);
}

function initFilters() {
    document.getElementById('fY').innerHTML = `<option value="1">Past 1 Year</option><option value="2">Past 2 Years</option><option value="3">Past 3 Years</option><option value="all">All Time</option>`;
    
    // Attach debounced filter to search input
    document.getElementById('q').addEventListener('input', debounce(() => filter(), 300));
    
    ['fY', 'fR'].forEach(id => document.getElementById(id).addEventListener('change', () => { updateDropdownOptions(); filter(); }));
    ['fP', 'fT'].forEach(id => document.getElementById(id).addEventListener('change', filter));
    updateDropdownOptions();
}

function updateDropdownOptions() {
    const timeFiltered = getFilteredData(true);
    const reg = document.getElementById('fR').value;
    
    populateDropdown('fR', 'REGION', 'All Regions', timeFiltered);
    populateDropdown('fT', 'LSTRIGGER', 'All Triggers', timeFiltered);
    populateDropdown('fP', 'PROVINCE', 'All Provinces', reg ? timeFiltered.filter(i => i.REGION === reg) : timeFiltered);
}

function populateDropdown(id, key, label, data) {
    const el = document.getElementById(id);
    const cur = el.value;
    const items = [...new Set(data.map(i => i[key]))].filter(v => v && v !== 'Unknown').sort();
    el.innerHTML = `<option value="">${label}</option>` + items.map(v => `<option value="${v}">${v}</option>`).join('');
    if (items.includes(cur)) el.value = cur;
}

function getFilteredData(onlyTime = false) {
    const tF = document.getElementById('fY').value;
    const now = new Date();
    const cutoff = tF === '1' ? new Date(now.getFullYear()-1,0) : tF === '2' ? new Date(now.getFullYear()-2,0) : tF === '3' ? new Date(now.getFullYear()-3,0) : new Date(0);
    
    let res = db.filter(i => new Date(i.YYYYMMDD || 0) >= cutoff || tF === 'all');
    if (onlyTime) return res;
    
    const q = document.getElementById('q').value.toLowerCase().trim();
    const fExtent = document.getElementById('fExtent');
    const applyExtent = fExtent ? fExtent.checked : false;
    let bounds = null;
    if (applyExtent) bounds = map.getBounds();

    const fR = document.getElementById('fR').value;
    const fP = document.getElementById('fP').value;
    const fT = document.getElementById('fT').value;

    return res.filter(i => 
        (!applyExtent || (i.lat !== null && i.lng !== null && bounds.contains([i.lat, i.lng]))) &&
        (!q || i.searchStr.includes(q)) && // Using pre-compiled O(1) string check
        (!fR || i.REGION === fR) &&
        (!fP || i.PROVINCE === fP) &&
        (!fT || i.LSTRIGGER === fT)
    );
}

// --- PAGINATION & LIST RENDERER ---
function filter() {
    if (!db || db.length === 0) return; // Guard clause against empty DB
    currentFilteredData = getFilteredData();
    document.getElementById('rec-count').innerText = `${currentFilteredData.length} RECORDS MATCHED`;
    
    currentPage = 1; 
    renderPaginatedList();
    buildCharts(currentFilteredData);
}

function changePage(direction) {
    currentPage += direction;
    document.getElementById('feed').scrollTop = 0;
    renderPaginatedList();
}

function renderPaginatedList() {
    markers.clearLayers();
    const feedEl = document.getElementById('feed');
    const paginationEl = document.getElementById('paginationControls');

    if (currentFilteredData.length === 0) {
        feedEl.innerHTML = '<div style="padding:40px; text-align:center; font-size:18px; font-weight:bold; color:var(--text-muted); width:100%;">No records found. Adjust your filters or map.</div>';
        paginationEl.innerHTML = '';
        return;
    }

    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const pageData = currentFilteredData.slice(startIndex, endIndex);
    const totalPages = Math.ceil(currentFilteredData.length / ITEMS_PER_PAGE);

    // Only render markers for the items currently on screen to optimize Leaflet Canvas
    pageData.forEach(i => {
        if(i.lat) L.circleMarker([i.lat, i.lng], {radius:8, fillColor:i.deaths>0?'#ef4444':'#f59e0b', color:'#fff', fillOpacity:0.9}).addTo(markers).on('click', () => openReport(i));
    });

    feedEl.innerHTML = pageData.map(i => {
        const safeStringify = JSON.stringify(i).replace(/'/g, "&apos;").replace(/"/g, "&quot;");
        return `
            <div class="list-row ${i.deaths > 0 ? 'high-risk' : ''}" onclick="openReport(${safeStringify})">
                <div class="lr-id">${i.LSID || 'N/A'}</div>
                <div class="lr-date">${i.YYYYMMDD || 'Unknown'}</div>
                <div class="lr-col lr-loc">${i.MUNICIPALITY || 'Unknown'}, ${i.PROVINCE || 'Unknown'}</div>
                <div class="lr-col"><span class="lr-trig">${i.LSTRIGGER || 'Registry Entry'}</span></div>
                ${i.deaths > 0 ? `<div class="lr-badge">💀 ${i.deaths} FATALITIES</div>` : ''}
            </div>
        `;
    }).join('');

    paginationEl.innerHTML = `
        <button class="btn btn-sec" ${currentPage === 1 ? 'disabled' : ''} onclick="changePage(-1)" style="width: auto;">◀ Prev</button>
        <span style="font-weight: 900; color: var(--primary);">Page ${currentPage} of ${totalPages}</span>
        <button class="btn btn-sec" ${currentPage === totalPages ? 'disabled' : ''} onclick="changePage(1)" style="width: auto;">Next ▶</button>
    `;
}

// --- UX LOGIC & ANIMATIONS ---
function flyToLocation(i) {
    if (i.lat !== null && i.lng !== null) {
        closeModal();
        const mapDiv = document.getElementById('map');
        if (mapDiv.classList.contains('hidden-view')) toggleView('split');
        
        map.flyTo([i.lat, i.lng], 14, { animate: true, duration: 1.5 });
        const ping = L.circleMarker([i.lat, i.lng], { radius: 30, color: '#10b981', fillColor: '#10b981', fillOpacity: 0.3, weight: 3 }).addTo(map);
        setTimeout(() => { if (map.hasLayer(ping)) map.removeLayer(ping); }, 3000);
    } else {
        alert("Cannot locate: This record does not have valid GPS coordinates.");
    }
}

function toggleView(viewType) {
    const mapDiv = document.getElementById('map');
    const feedDiv = document.getElementById('feed');
    const pagDiv = document.getElementById('paginationControls');
    const btn = document.getElementById('toggleViewBtn');

    if (viewType === 'map') {
        mapDiv.classList.remove('hidden-view'); mapDiv.classList.add('full-map'); feedDiv.classList.add('hidden-view'); pagDiv.classList.add('hidden-view');
        btn.innerText = 'Expand Data List'; btn.style.background = 'var(--secondary)'; btn.onclick = () => toggleView('list');
    } else if (viewType === 'list') {
        mapDiv.classList.add('hidden-view'); mapDiv.classList.remove('full-map'); feedDiv.classList.remove('hidden-view'); pagDiv.classList.remove('hidden-view');
        btn.innerText = 'Show Split View'; btn.style.background = '#10b981'; btn.onclick = () => toggleView('split');
    } else {
        mapDiv.classList.remove('hidden-view', 'full-map'); feedDiv.classList.remove('hidden-view'); pagDiv.classList.remove('hidden-view');
        btn.innerText = 'Expand Map'; btn.style.background = 'var(--accent)'; btn.onclick = () => toggleView('map');
    }
    if (!mapDiv.classList.contains('hidden-view')) setTimeout(() => map.invalidateSize(), 300);
}

// --- MODALS ---
function openCharts() { document.getElementById('chartModal').style.display = 'flex'; }
function closeCharts() { document.getElementById('chartModal').style.display = 'none'; }
function closeModal() { document.getElementById('dataModal').style.display = 'none'; }

function openReport(i) {
    if(!i) return;
    const b = document.getElementById('m-body');
    const row = (l, v) => `<div class="field-grp"><div class="f-lbl">${l}</div><div class="f-val">${v || '—'}</div></div>`;
    const safeStringify = JSON.stringify(i).replace(/'/g, "&apos;").replace(/"/g, "&quot;");
    
    b.innerHTML = `
        <div class="report-header">
            <div>
                <h2>${i.MUNICIPALITY || 'Unknown Area'} Landslide</h2>
                <div class="report-meta">
                    ${i.PROVINCE || '—'} | ${i.REGION || '—'} | Date: ${i.YYYYMMDD || 'Unknown'} at ${i['12HOURFO'] || '—'} ${i.AMPM || ''}
                </div>
            </div>
            ${(i.lat !== null && i.lng !== null) ? 
                `<button class="btn btn-main no-print btn-sm" style="white-space:nowrap; width:auto;" onclick="flyToLocation(${safeStringify})">📍 Map</button>` 
                : '<span class="no-gps-badge no-print">NO GPS DATA</span>'}
        </div>

        <div class="sec-title">A. Spatial Geography</div>
        <div class="grid-2">
            ${row('Coordinates', (i.lat !== null && i.lng !== null) ? `${i.lat}, ${i.lng}` : 'Unmapped')} ${row('Precision', i.LATLONGR)}
            ${row('Barangay', i.BARANGAY)} ${row('Sitio', i.SITIO)}
            ${row('Elevation', i.ELEVATION)} ${row('Accessibility', i.ACCESIBILITY)}
            ${row('Topography/Location Details', i.LSLOCDETAILS)}
        </div>

        <div class="sec-title">B. Technical Characteristics</div>
        <div class="grid-2">
            ${row('Trigger Event (LSTRIGGER)', i.LSTRIGGER)} ${row('Category (LSCATEGORY)', i.LSCATEGORY)}
            ${row('Dimensions (H x L x W)', `${i.HeightTaas || 0}m x ${i.LengthHaba || 0}m x ${i.WidthLapad || 0}m`)}
            ${row('Land Cover', i.LANDCOVER)}
            ${row('AWS Data Link', i.AWSDATA)} ${row('Other Land Features', i.OTHERLAND)}
        </div>
        <div style="margin-top:15px;">${row('Additional Information', i.OTHERINFO)}</div>

        <div class="sec-title">C. Casualties & Impact</div>
        <div class="grid-2">
            ${row('DEATHS', i.deaths)} ${row('INJURED', i.injured)}
            ${row('Displaced Persons', i.displaced)} ${row('Evacuation Site', i.EVACUATIONSITE)}
        </div>

        <div class="sec-title">D. Verification & Sources</div>
        <div class="grid-2">
            ${row('General Source', i.GENERALSOURCES)} ${row('Specific Source', i.SPECIFICSOURCE)}
            ${row('External Link', i.SOURCELINK ? `<a href="${i.SOURCELINK}" target="_blank" style="color:var(--accent); text-decoration:underline;">Open Official Source</a>` : '—')}
            ${row('Date/Time Recorded', i.DATETIMERECORDED)}
        </div>
        
        <div class="report-remarks">
            ${row('Analyst/Encoder Remarks', i.DATETIMEREMARKS)}
            <div class="encoder-meta">Encoded by: ${i.ENCODERNAME || 'N/A'} | Timestamp: ${i.TIMESTAMP || 'N/A'}</div>
        </div>

        ${i.IMAGELINK ? `<div class="sec-title">E. Site Imagery</div><img src="${i.IMAGELINK}" class="report-img">` : ''}
        
        <div class="print-only">
            This report is gathered by project LIGTAS (DOST & UPLB-SESAM).
        </div>
    `;
    
    document.getElementById('dataModal').style.display = 'flex';
}

// --- DYNAMIC ANALYTICS ENGINE ---

// Pre-compute static data to save overhead
function computeAllTimeMetrics() {
    allTimeMetrics = { 
        coords:{'Has GPS':0,'No GPS':0}, loc:{'Has Location':0,'No Location':0}, 
        date:{'Has Date':0,'Unknown Date':0}, time:{'Has Time':0,'No Time':0},
        trigger:{'Has Data':0,'No Data':0}, category:{'Has Data':0,'No Data':0}
    };
    db.forEach(i => {
        i.lat ? allTimeMetrics.coords['Has GPS']++ : allTimeMetrics.coords['No GPS']++;
        (i.PROVINCE||i.MUNICIPALITY) ? allTimeMetrics.loc['Has Location']++ : allTimeMetrics.loc['No Location']++;
        (i.YYYYMMDD && i.year !== 'Unknown') ? allTimeMetrics.date['Has Date']++ : allTimeMetrics.date['Unknown Date']++;
        (i['12HOURFO']) ? allTimeMetrics.time['Has Time']++ : allTimeMetrics.time['No Time']++;
        (i.LSTRIGGER && String(i.LSTRIGGER).trim() !== '' && i.LSTRIGGER !== 'Unspecified') ? allTimeMetrics.trigger['Has Data']++ : allTimeMetrics.trigger['No Data']++;
        (i.LSCATEGORY && String(i.LSCATEGORY).trim() !== '' && i.LSCATEGORY !== 'Unspecified') ? allTimeMetrics.category['Has Data']++ : allTimeMetrics.category['No Data']++;
    });
}

function buildCharts(data) {
    if (!data) return;
    const totalEl = document.getElementById('totalReportCount');
    if(totalEl) totalEl.innerText = `ANALYZING ${data.length} MATCHING RECORDS`;
    
    // Performance Optimization: Destroy ONLY dynamic charts, leave static ones alone unless theme changed
    ['year','prov','trig','genSrc','specSrc'].forEach(id => charts['chart'+id.charAt(0).toUpperCase()+id.slice(1)]?.destroy());

    const c = { year:{}, prov:{}, trig:{}, genSrc:{}, specSrc:{} };
    data.forEach(i => {
        if(i.year !== 'Unknown') c.year[i.year] = (c.year[i.year]||0)+1;
        if(i.PROVINCE) c.prov[i.PROVINCE] = (c.prov[i.PROVINCE]||0)+1;
        c.trig[i.LSTRIGGER||'Unspecified'] = (c.trig[i.LSTRIGGER||'Unspecified']||0)+1;
        c.genSrc[i.GENERALSOURCES||'N/A'] = (c.genSrc[i.GENERALSOURCES||'N/A']||0)+1;
        c.specSrc[i.SPECIFICSOURCE||'N/A'] = (c.specSrc[i.SPECIFICSOURCE||'N/A']||0)+1;
    });

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const labelColor = isDark ? '#cbd5e1' : '#475569';

    const createScrollableBar = (id, obj, color) => {
        let ent = Object.entries(obj).sort((a,b)=>b[1]-a[1]);
        const el = document.getElementById(id);
        const wrapper = document.getElementById('wrap-' + id);
        if(!el || !wrapper) return;
        wrapper.style.height = Math.max(300, ent.length * 35) + 'px';
        charts[id] = new Chart(el, { 
            type:'bar', data: { labels: ent.map(x=>x[0]), datasets: [{data: ent.map(x=>x[1]), backgroundColor: color, borderRadius: 4}] }, 
            options: { maintainAspectRatio: false, indexAxis:'y', plugins: { legend: {display:false}, datalabels: {color: labelColor, anchor:'end', align:'right', font: {weight:'bold', size:12}, formatter: v => v>0?v:''} }, layout: {padding: {right: 40}}, scales: { y: { ticks: { font: {weight:'bold'} } } } } 
        });
    };

    const createDonut = (id, obj, colors, hide) => {
        const el = document.getElementById(id);
        if(!el) return;
        charts[id] = new Chart(el, { 
            type:'doughnut', data: { labels: Object.keys(obj), datasets: [{ data: Object.values(obj), backgroundColor: colors, borderColor: isDark ? '#1e293b' : '#ffffff' }] }, 
            options: { maintainAspectRatio: false, plugins: { legend: hide?{display:false}:{position:'bottom', labels: {font: {size:12, weight:'bold'}}}, datalabels: hide?{display:false}:{color:'#fff', font: {weight:'bold', size:12}, textAlign:'center', formatter:(v,c)=>{if(v===0)return''; let s=0; c.chart.data.datasets[0].data.map(d=>s+=d); return `${v}\n(${(v*100/s).toFixed(1)}%)`}} } } 
        });
    };

    // Render Dynamic Charts
    const elYear = document.getElementById('chartYear');
    if(elYear) charts['chartYear'] = new Chart(elYear, { type:'bar', data: { labels: Object.keys(c.year).sort(), datasets: [{data: Object.values(c.year), backgroundColor: '#3b82f6', borderRadius: 4}] }, options: { maintainAspectRatio: false, plugins: {legend:{display:false}, datalabels: {color: labelColor, anchor:'end', align:'top', font:{weight:'bold', size:13}, formatter:v=>v>0?v:''}}, layout:{padding:{top:25}}, scales: { x: { ticks: { font: {weight:'bold'} } } } } });
    
    createScrollableBar('chartProv', c.prov, '#f59e0b');
    createScrollableBar('chartGenSrc', c.genSrc, '#8b5cf6');
    createScrollableBar('chartSpecSrc', c.specSrc, '#ec4899');
    
    let trigsSorted = Object.entries(c.trig).sort((a,b)=>b[1]-a[1]);
    let sortedTrigObj = {}; trigsSorted.forEach(item => sortedTrigObj[item[0]] = item[1]);
    const trigPalette = ['#ef4444','#f59e0b','#3b82f6','#10b981','#6366f1','#8b5cf6','#ec4899','#14b8a6','#f43f5e', '#64748b', '#06b6d4'];
    
    createDonut('chartTrig', sortedTrigObj, trigPalette, true);

    const tBody = document.getElementById('tableTrig');
    if(tBody) {
        let tot = Object.values(c.trig).reduce((a, b) => a + b, 0);
        tBody.innerHTML = `<div class="table-responsive"><table class="stats-table"><thead><tr><th style="padding:10px;">Trigger Event (LSTRIGGER)</th><th style="padding:10px; text-align:center;">Count</th><th style="padding:10px; text-align:center;">Share</th></tr></thead><tbody>` + 
        trigsSorted.map((item, i) => `<tr><td style="display:flex; align-items:center; gap:8px;"><span style="width:12px; height:12px; background:${trigPalette[i%trigPalette.length]}; border-radius:50%; display:inline-block; flex-shrink:0;"></span><span style="line-height:1.3;">${item[0]}</span></td><td style="text-align:center; font-weight:900; color:#fef08a; font-size:14px;">${item[1]}</td><td style="text-align:center; color:var(--text-muted);">${tot>0?((item[1]/tot)*100).toFixed(1)+'%':'0%'}</td></tr>`).join('') + `</tbody></table></div>`;
    }

    // Performance Optimization: Render heavy ALL-TIME Completeness metrics only ONCE
    if (!allTimeChartsRendered && allTimeMetrics) {
        createDonut('chartCoords', allTimeMetrics.coords, ['#0f766e','#eab308']);
        createDonut('chartLoc', allTimeMetrics.loc, ['#0f766e','#eab308']);
        createDonut('chartDate', allTimeMetrics.date, ['#0f766e','#eab308']);
        createDonut('chartTime', allTimeMetrics.time, ['#0f766e','#eab308']);
        createDonut('chartCompletenessTrig', allTimeMetrics.trigger, ['#0f766e','#eab308']);
        createDonut('chartCompletenessCat', allTimeMetrics.category, ['#0f766e','#eab308']);
        allTimeChartsRendered = true;
    }
}

// --- UTILITIES ---
function downloadChart(id, name) {
    const canvas = document.getElementById(id), temp = document.createElement('canvas');
    if(!canvas) return;
    temp.width = canvas.width; temp.height = canvas.height;
    const ctx = temp.getContext('2d'); 
    ctx.fillStyle = document.documentElement.getAttribute('data-theme') === 'dark' ? '#1e293b' : '#ffffff'; 
    ctx.fillRect(0,0,temp.width,temp.height); ctx.drawImage(canvas,0,0);
    const link = document.createElement('a'); link.download = name+'.png'; link.href = temp.toDataURL('image/png'); link.click();
}

function setStatus(msg, type) { document.getElementById('sys-text').innerText = msg; document.getElementById('sys-pulse').className = `pulse ${type}`; }

function locateUser() {
    setStatus('SEARCHING GPS...', 'warning');
    map.locate({setView: true, maxZoom: 14});
    map.on('locationfound', (e) => {
        if(userMarker) map.removeLayer(userMarker);
        userMarker = L.circle(e.latlng, { radius: 100, color: '#3b82f6' }).addTo(map);
        setStatus('GPS LOCKED', 'online');
    });
    map.on('locationerror', () => { setStatus('GPS DENIED', 'error'); alert("Please enable location services."); });
}

function reset() {
    document.getElementById('q').value = '';
    document.getElementById('fY').value = '1'; 
    document.getElementById('fR').value = '';
    document.getElementById('fP').value = '';
    document.getElementById('fT').value = '';
    
    const extToggle = document.getElementById('fExtent');
    if(extToggle) extToggle.checked = false;
    
    map.setView(PH_CENTER, 5);
    updateDropdownOptions(); 
    filter(); 
}

window.onload = init;
