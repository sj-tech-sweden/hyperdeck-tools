let localConfigCache = {};
let activeDestinationInput = null; // References the active row input element being modified
let globallyActiveEventId = 'default';
let availablePlugins = [];
let discoveredStages = [];
let scheduleFilterMode = 'all';
let scheduleDataCache = [];
let currentPluginSelection = '';
const PLUGIN_SELECTION_STORAGE_KEY = 'hyperdeck.schedulePluginSelection';
let scheduleSaveDebounceTimer = null;
let scheduleTempRowCounter = 0;

function createTempRowKey() {
    scheduleTempRowCounter += 1;
    return `tmp:${Date.now()}:${scheduleTempRowCounter}`;
}

function splitStartTimeParts(startTime) {
    const raw = (startTime || '').trim();
    if (!raw) return { datePart: '', timePart: '' };

    const normalized = raw.includes('T') ? raw.replace('T', ' ') : raw;
    if (normalized.includes(' ')) {
        const [firstPart = '', rawTime = ''] = normalized.split(' ', 2);
        const datePart = normalizeTypedDate(firstPart) || '';
        const timePart = normalizeTypedTime(rawTime) || '';
        return { datePart, timePart };
    }

    const dateOnly = normalizeTypedDate(normalized);
    if (dateOnly) return { datePart: dateOnly, timePart: '' };

    const timeOnly = normalizeTypedTime(normalized);
    if (timeOnly) return { datePart: '', timePart: timeOnly };

    return { datePart: '', timePart: '' };
}

function normalizeTypedDate(value) {
    const raw = (value || '').trim();
    if (!raw) return '';

    let match = raw.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/);
    if (match) {
        const y = match[1];
        const m = match[2].padStart(2, '0');
        const d = match[3].padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    match = raw.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);
    if (match) {
        const d = match[1].padStart(2, '0');
        const m = match[2].padStart(2, '0');
        const y = match[3];
        return `${y}-${m}-${d}`;
    }

    return '';
}

function normalizeTypedTime(value) {
    const raw = (value || '').trim();
    if (!raw) return '';

    const match = raw.match(/^(\d{1,2})[:.](\d{1,2})(?::\d{1,2})?$/);
    if (!match) return '';

    const hour = Number.parseInt(match[1], 10);
    const minute = Number.parseInt(match[2], 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return '';
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return '';
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function hintBadge(message) {
    return `<span class="ml-1 inline-flex flex-col align-top group cursor-help" tabindex="0" aria-label="Hint"><span class="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-slate-700 text-[9px] text-slate-500">?</span><span class="hidden group-hover:block group-focus:block mt-1 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-[10px] normal-case leading-snug text-slate-300 break-words max-w-44">${message}</span></span>`;
}

/** Escape a string for safe insertion into HTML to prevent XSS. */
function escHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function openNativePicker(inputEl) {
    if (!inputEl) return;
    inputEl.focus();
    if (typeof inputEl.showPicker === 'function') {
        try {
            inputEl.showPicker();
            return;
        } catch (_) {
            // Ignore browsers that block showPicker in certain interaction paths.
        }
    }
    inputEl.click();
}

function openSiblingPicker(buttonEl, kind) {
    const row = buttonEl.closest('.schedule-row-item');
    if (!row) return;

    const isDate = kind === 'date';
    const input = row.querySelector(isDate ? '.sch-date' : '.sch-time');
    openNativePicker(input);
}

function updateAutoModeBadge() {
    const badge = document.getElementById('hud-mode-badge');
    if (!badge) return;

    const modeSelect = document.getElementById('cfg-auto-mode');
    const isAuto = (modeSelect ? modeSelect.value : (localConfigCache.schedule_auto_mode ? 'true' : 'false')) === 'true';

    badge.innerText = isAuto ? 'AUTO' : 'MANUAL';
    badge.className = isAuto
        ? 'text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
        : 'text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30';
}

function normalizeStageName(stage) {
    return (stage || '').toString().trim();
}

function scheduleItemKey(item) {
    const id = (item.id || '').toString().trim().toLowerCase();
    if (id) return `id:${id}`;

    const startTime = (item.start_time || '').toString().trim().toLowerCase();
    const title = (item.planned_title || '').toString().trim().toLowerCase();
    const stage = normalizeStageName(item.stage).toLowerCase();
    if (!startTime && !title && !stage) return '';
    return `ts:${startTime}|${title}|${stage}`;
}

function isScheduleItemInScope(item) {
    const stage = normalizeStageName(item.stage).toLowerCase();
    const stageSet = configuredStageSet();
    if (stageSet.size === 0) return true;
    return !!stage && stageSet.has(stage);
}

function getVisibleScheduleRowsFromDOM() {
    const rows = [];
    document.querySelectorAll('.schedule-row-item').forEach((el, idx) => {
        const id = el.querySelector('.sch-id')?.value.trim() || '';
        const plannedTitle = el.querySelector('.sch-title')?.value.trim() || '';
        const date = el.querySelector('.sch-date')?.value || '';
        const time = el.querySelector('.sch-time')?.value || '';
        const stage = normalizeStageName(el.querySelector('.sch-stage')?.value || '');
        const start_time = date && time ? `${date} ${time}` : (date || time || '');
        const domKey = decodeURIComponent(el.dataset.rowKey || '');

        let resolvedId = id;
        if (!resolvedId && start_time) {
            const safeTitle = (plannedTitle || `event_${idx + 1}`).replace(/\s+/g, '_').replace(/[^\w\-]/g, '').toLowerCase();
            resolvedId = `${start_time}_${safeTitle}`;
        }

        rows.push({
            _key: domKey,
            _row_key: domKey || createTempRowKey(),
            id: resolvedId,
            planned_title: plannedTitle,
            start_time,
            stage,
        });
    });
    return rows;
}

function mergeVisibleRowsIntoCache() {
    const visibleRows = getVisibleScheduleRowsFromDOM();
    if (visibleRows.length === 0) return;

    const next = [...scheduleDataCache];
    visibleRows.forEach(row => {
        const candidate = {
            _row_key: row._row_key,
            id: row.id,
            planned_title: row.planned_title,
            start_time: row.start_time,
            stage: row.stage,
        };
        const rowKey = row._key || row._row_key || scheduleItemKey(candidate);
        if (!rowKey) {
            next.push(candidate);
            return;
        }

        const index = next.findIndex(item => item._row_key === rowKey || scheduleItemKey(item) === rowKey);
        if (index >= 0) next[index] = candidate;
        else next.push(candidate);
    });
    scheduleDataCache = next;
}

function applyScheduleScopeFilter(schedule) {
    if (scheduleFilterMode === 'in_scope') {
        return schedule.filter(item => isScheduleItemInScope(item));
    }
    return schedule;
}

function configuredStageSet() {
    const modeEl = document.getElementById('cfg-stage-mode');
    const globalStageEl = document.getElementById('cfg-global-stage');
    const mode = modeEl ? modeEl.value : (localConfigCache.stage_mode || 'global');

    if (mode === 'per_deck') {
        const set = new Set();
        const stageInputs = document.querySelectorAll('.d-stage');
        if (stageInputs.length > 0) {
            stageInputs.forEach(input => {
                const value = normalizeStageName(input.value);
                if (value) set.add(value.toLowerCase());
            });
            return set;
        }

        Object.values(localConfigCache.deck_stages || {}).forEach(stage => {
            const value = normalizeStageName(stage);
            if (value) set.add(value.toLowerCase());
        });
        return set;
    }

    const globalStage = normalizeStageName(globalStageEl ? globalStageEl.value : localConfigCache.global_stage);
    return globalStage ? new Set([globalStage.toLowerCase()]) : new Set();
}

function updateStageSuggestionUI(schedule = []) {
    const stageValues = new Set(discoveredStages.map(s => s.toLowerCase()));
    schedule.forEach(item => {
        const stage = normalizeStageName(item.stage);
        if (stage) stageValues.add(stage.toLowerCase());
    });

    const normalizedUnique = [];
    stageValues.forEach(stageLower => {
        const original = [...discoveredStages, ...schedule.map(s => normalizeStageName(s.stage))]
            .find(candidate => normalizeStageName(candidate).toLowerCase() === stageLower);
        if (original) normalizedUnique.push(original);
    });

    discoveredStages = normalizedUnique.sort((a, b) => a.localeCompare(b));

    const datalist = document.getElementById('cfg-stage-options');
    const sourceLabel = document.getElementById('cfg-stage-source');
    if (!datalist || !sourceLabel) return;

    datalist.innerHTML = '';
    discoveredStages.forEach(stage => {
        const option = document.createElement('option');
        option.value = stage;
        datalist.appendChild(option);
    });

    if (discoveredStages.length === 0) {
        sourceLabel.innerText = 'No stage list discovered yet. Sync a plugin to populate stage suggestions.';
    } else {
        sourceLabel.innerText = `Plugin stages found: ${discoveredStages.join(', ')}`;
    }
}

function ensureConfigShape(config) {
    const safe = config || {};
    if (!safe.destinations || !Array.isArray(safe.destinations)) safe.destinations = [];
    if (!safe.hyperdecks || typeof safe.hyperdecks !== 'object') safe.hyperdecks = {};
    if (!safe.deck_stages || typeof safe.deck_stages !== 'object') safe.deck_stages = {};
    if (!safe.stage_mode || !['global', 'per_deck'].includes(safe.stage_mode)) safe.stage_mode = 'global';
    if (typeof safe.global_stage !== 'string') safe.global_stage = '';
    if (typeof safe.schedule_auto_mode !== 'boolean') safe.schedule_auto_mode = true;
    if (typeof safe.schedule_max_drift_minutes !== 'number') safe.schedule_max_drift_minutes = 45;
    if (typeof safe.filename_template !== 'string') safe.filename_template = '{year}{month}{day}_{planned_title}';
    return safe;
}

function updateStageModeUI() {
    const modeEl = document.getElementById('cfg-stage-mode');
    const globalStageEl = document.getElementById('cfg-global-stage');
    const isPerDeck = modeEl.value === 'per_deck';

    globalStageEl.disabled = isPerDeck;
    globalStageEl.classList.toggle('opacity-50', isPerDeck);
    document.querySelectorAll('.d-stage').forEach(input => {
        input.disabled = !isPerDeck;
        input.classList.toggle('opacity-50', !isPerDeck);
    });

    mergeVisibleRowsIntoCache();
    if (scheduleDataCache.length) renderScheduleMatrix(scheduleDataCache, true);
}

async function updateDashboardMetrics() {
    try {
        const res = await fetch('/api/state');
        const state = await res.json();
        const container = document.getElementById('decks-container');

        // Keep the staging HUD aligned with backend auto-selected active context.
        try {
            const activeContextRes = await fetch('/api/schedule/active');
            if (activeContextRes.ok) {
                const activeContext = await activeContextRes.json();
                const nextId = (activeContext?.id || 'default').toString();
                const nextTitle = (activeContext?.planned_title || '').toString();
                if (nextId !== globallyActiveEventId) {
                    globallyActiveEventId = nextId;
                    updateLiveStagingHUD(nextId, nextTitle);
                    if (scheduleDataCache.length) renderScheduleMatrix(scheduleDataCache, true);
                } else {
                    updateLiveStagingHUD(nextId, nextTitle);
                }
            }
        } catch (_) {
            // HUD sync failures should not block deck status updates.
        }
        
        if (Object.keys(state).length === 0) {
            container.innerHTML = `<div class="col-span-2 text-center p-8 border border-dashed border-slate-800 text-slate-500 text-sm rounded-lg">No monitored hardware devices configured. Add hosts to start tracking.</div>`;
            return;
        }

        let html = '';
        for (const [ip, item] of Object.entries(state)) {
            const isRecording = item.status.toLowerCase() === 'recording';
            const pulseClass = isRecording ? 'bg-red-500 animate-pulse' : (item.connected ? 'bg-emerald-500' : 'bg-rose-500');
            const statusLabel = item.connected ? (item.status === 'Online' ? 'Online' : item.status) : item.status;
            // JSON literals are HTML-escaped before inserting into inline attributes.
            const jsIpAttr = escHtml(JSON.stringify(ip));
            const jsNameAttr = escHtml(JSON.stringify(item.name || ''));
            
            html += `
            <div class="rounded-lg border border-slate-800 bg-slate-900 p-5 shadow-sm">
                <div class="flex items-center justify-between mb-4">
                    <div>
                        <h3 class="font-semibold text-white text-base">${escHtml(item.name)}</h3>
                        <p class="text-xs text-slate-400 font-mono">${escHtml(ip)}</p>
                    </div>
                    <span class="inline-flex items-center gap-x-1.5 rounded-full px-2 py-1 text-xs font-medium text-white ring-1 ring-inset ring-slate-800">
                        <svg class="h-1.5 w-1.5 ${pulseClass} rounded-full" viewBox="0 0 6 6" aria-hidden="true"><circle cx="3" cy="3" r="3" /></svg>
                        ${escHtml(statusLabel)}
                    </span>
                </div>
                ${item.stage ? `<div class="text-[11px] text-indigo-300 mb-2">Stage: ${escHtml(item.stage)}</div>` : ''}
                ${item.next_event ? `<div class="text-[11px] text-slate-300 mb-1">Next: <span class="text-white">${escHtml(item.next_event.planned_title || 'Unnamed Event')}</span> (${escHtml(item.next_event.start_time || 'No time')})</div>` : '<div class="text-[11px] text-slate-500 mb-1">Next: No matching schedule event found</div>'}
                ${item.matched_event ? `<div class="text-[11px] mb-2 ${item.auto_selected ? 'text-emerald-300' : 'text-slate-400'}">Auto Match: ${escHtml(item.matched_event.planned_title)} (${escHtml(item.matched_event.minutes_diff)} min diff)</div>` : '<div class="text-[11px] text-slate-500 mb-2">Auto Match: None within drift window</div>'}
                
                ${item.progress > 0 || item.file ? `
                    <div class="space-y-1">
                        <div class="flex justify-between text-xs font-mono text-slate-400 truncate">
                            <span class="truncate pr-4">${escHtml(item.file)}</span>
                            <span>${parseInt(item.progress, 10)}%</span>
                        </div>
                        <div class="w-full bg-slate-950 rounded-full h-1.5 overflow-hidden">
                            <div class="bg-indigo-500 h-1.5 rounded-full transition-all duration-300" style="width: ${parseInt(item.progress, 10)}%"></div>
                        </div>
                    </div>
                ` : `<div class="text-xs text-slate-500 italic">No storage IO operations running</div>`}

                <!-- Per-deck transport controls -->
                <div class="mt-4 flex items-center gap-2 border-t border-slate-800 pt-3">
                    <button onclick="sendDeckCommand(${jsIpAttr}, 'record')"
                        class="flex-1 rounded bg-red-600/90 hover:bg-red-500 px-2 py-1.5 text-xs font-semibold text-white transition cursor-pointer">
                        ⏺ Record
                    </button>
                    <button onclick="sendDeckCommand(${jsIpAttr}, 'stop')"
                        class="flex-1 rounded bg-slate-700 hover:bg-slate-600 px-2 py-1.5 text-xs font-semibold text-white transition cursor-pointer">
                        ⏹ Stop
                    </button>
                    <button onclick="openDeckSettings(${jsIpAttr}, ${jsNameAttr})"
                        class="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1.5 text-xs text-slate-300 hover:text-white transition cursor-pointer" title="Deck settings">
                        ⚙
                    </button>
                </div>
            </div>`;
        }
        container.innerHTML = html;
    } catch (e) { console.error("Error updates tracking dropped out: ", e); }
}

async function pullConfigurationMatrix() {
    try {
        const res = await fetch('/api/config');
        localConfigCache = ensureConfigShape(await res.json());
        
        document.getElementById('cfg-template').value = localConfigCache.filename_template;
        document.getElementById('cfg-stage-mode').value = localConfigCache.stage_mode;
        document.getElementById('cfg-global-stage').value = localConfigCache.global_stage;
        document.getElementById('cfg-auto-mode').value = localConfigCache.schedule_auto_mode ? 'true' : 'false';
        document.getElementById('cfg-drift-minutes').value = localConfigCache.schedule_max_drift_minutes;

        const stageModeSelect = document.getElementById('cfg-stage-mode');
        if (!stageModeSelect.dataset.bound) {
            stageModeSelect.addEventListener('change', updateStageModeUI);
            stageModeSelect.dataset.bound = 'true';
        }

        const autoModeSelect = document.getElementById('cfg-auto-mode');
        if (!autoModeSelect.dataset.bound) {
            autoModeSelect.addEventListener('change', updateAutoModeBadge);
            autoModeSelect.dataset.bound = 'true';
        }
        
        renderConfigDestinationsList();
        renderConfigDecksList();
        updateStageModeUI();
        updateAutoModeBadge();
    } catch (e) { console.error("Failed pulling core platform config profile settings: ", e); }
}

// --- Dynamic Destination Rows Management ---
function renderConfigDestinationsList() {
    const list = document.getElementById('cfg-destinations-list');
    list.innerHTML = '';
    
    if (localConfigCache.destinations && localConfigCache.destinations.length > 0) {
        localConfigCache.destinations.forEach(path => {
            list.appendChild(createDestinationRowElement(path));
        });
    } else {
        addDestinationRow();
    }
}

function createDestinationRowElement(path = '') {
    const div = document.createElement('div');
    div.className = 'flex gap-2 items-center row-destination-item';
    div.innerHTML = `
        <input type="text" placeholder="/mnt/storage/ingest" value="${path}" class="dest-path block w-full rounded-md border-0 bg-slate-950 px-2 py-1 text-xs text-white ring-1 ring-inset ring-slate-800 focus:outline-none font-mono">
        <button onclick="openFolderBrowser(this.previousElementSibling)" class="text-xs text-indigo-400 hover:text-indigo-300 font-medium cursor-pointer p-1" title="Browse host directory">📁</button>
        <button onclick="this.parentElement.remove()" class="text-rose-500 text-xs px-1 hover:text-rose-400 cursor-pointer">✕</button>
    `;
    return div;
}

function addDestinationRow(path = '') {
    document.getElementById('cfg-destinations-list').appendChild(createDestinationRowElement(path));
}

// --- Dynamic Device Mapping Rows Management ---
function renderConfigDecksList() {
    const list = document.getElementById('cfg-decks-list');
    list.innerHTML = '';
    const deckStages = localConfigCache.deck_stages || {};
    for (const [name, ip] of Object.entries(localConfigCache.hyperdecks)) {
        list.appendChild(createDeckRowElement(name, ip, deckStages[name] || ''));
    }
}

function createDeckRowElement(name='', ip='', stage='') {
    const div = document.createElement('div');
    div.className = 'flex gap-2 items-center row-deck-item';
    div.innerHTML = `
        <input type="text" placeholder="Device Label" value="${name}" class="d-name block w-1/3 rounded-md border-0 bg-slate-950 px-2 py-1 text-xs text-white ring-1 ring-inset ring-slate-800 focus:outline-none">
        <input type="text" placeholder="IP / Hostname" value="${ip}" class="d-ip block w-1/3 rounded-md border-0 bg-slate-950 px-2 py-1 text-xs text-white ring-1 ring-inset ring-slate-800 focus:outline-none">
        <input type="text" list="cfg-stage-options" placeholder="Stage" value="${stage}" class="d-stage block w-1/3 rounded-md border-0 bg-slate-950 px-2 py-1 text-xs text-white ring-1 ring-inset ring-slate-800 focus:outline-none">
        <button onclick="this.parentElement.remove()" class="text-rose-500 text-xs px-1 hover:text-rose-400 cursor-pointer">✕</button>
    `;
    return div;
}

function addDeckToConfigRow(name='', ip='') {
    document.getElementById('cfg-decks-list').appendChild(createDeckRowElement(name, ip));
    updateStageModeUI();
}

async function saveConfigToServer() {
    const filename_template = document.getElementById('cfg-template').value;
    const stage_mode = document.getElementById('cfg-stage-mode').value;
    const global_stage = document.getElementById('cfg-global-stage').value.trim();
    const schedule_auto_mode = document.getElementById('cfg-auto-mode').value === 'true';
    const schedule_max_drift_minutes = Number.parseInt(document.getElementById('cfg-drift-minutes').value || '45', 10);
    
    const destinations = [];
    document.querySelectorAll('.row-destination-item').forEach(el => {
        const path = el.querySelector('.dest-path').value.trim();
        if (path) destinations.push(path);
    });

    const hyperdecks = {};
    const deck_stages = {};
    document.querySelectorAll('.row-deck-item').forEach(el => {
        const name = el.querySelector('.d-name').value.trim();
        const ip = el.querySelector('.d-ip').value.trim();
        const stage = el.querySelector('.d-stage').value.trim();
        if(name && ip) {
            hyperdecks[name] = ip;
            if (stage) deck_stages[name] = stage;
        }
    });

    const payload = {
        destinations,
        filename_template,
        hyperdecks,
        stage_mode,
        global_stage,
        deck_stages,
        schedule_auto_mode,
        schedule_max_drift_minutes: Number.isFinite(schedule_max_drift_minutes) ? Math.max(0, schedule_max_drift_minutes) : 45,
    };
    try {
        const res = await fetch('/api/config', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        if(res.ok) {
            alert('Configuration updated and reloaded cleanly!');
            pullConfigurationMatrix();
        }
    } catch (e) { alert("Error trying to commit target configurations modifications."); }
}

async function triggerDiscovery() {
    const btn = document.getElementById('btn-discover');
    const panel = document.getElementById('discovery-panel');
    const list = document.getElementById('discovery-list');
    
    btn.disabled = true;
    btn.innerText = "Scanning Subnet...";
    panel.classList.remove('hidden');
    list.innerHTML = '<li class="text-sm p-4 text-slate-500 italic text-center animate-pulse">Scanning local subnet structure for active HyperDeck control slots...</li>';
    
    try {
        const res = await fetch('/api/discover');
        const data = await res.json();
        document.getElementById('discovery-subnet').innerText = `Scan Profile Target Base Range: ${data.subnet_scanned}`;

        const existingDeckByEndpoint = new Map();
        Object.entries(localConfigCache.hyperdecks || {}).forEach(([deckName, endpoint]) => {
            existingDeckByEndpoint.set(String(endpoint || '').trim().toLowerCase(), deckName);
        });
        
        if(data.found.length === 0) {
            list.innerHTML = '<li class="text-sm p-4 text-slate-400 text-center">No responsive production decks identified on default listening vectors.</li>';
        } else {
            list.innerHTML = '';
            data.found.forEach(ip => {
                const normalizedIp = String(ip || '').trim().toLowerCase();
                const existingDeckName = existingDeckByEndpoint.get(normalizedIp);
                const alreadyAdded = !!existingDeckName;
                const li = document.createElement('li');
                li.className = "py-2.5 flex justify-between items-center text-sm text-slate-200";
                li.innerHTML = `
                    <div class="min-w-0">
                        <span class="font-mono font-medium">${ip}</span>
                        ${alreadyAdded ? `<div class="text-[11px] text-emerald-300 mt-0.5">Already added as ${existingDeckName}</div>` : ''}
                    </div>
                    <button ${alreadyAdded ? 'disabled' : `onclick="addDeckToConfigRow('New_HyperDeck', '${ip}')"`} class="text-xs px-2 py-1 rounded border transition ${alreadyAdded ? 'bg-emerald-600/10 text-emerald-300 border-emerald-500/30 cursor-not-allowed' : 'bg-indigo-600/30 text-indigo-400 border-indigo-500/30 hover:bg-indigo-600 hover:text-white cursor-pointer'}">
                        ${alreadyAdded ? 'Already Added' : '+ Add to System'}
                    </button>
                `;
                list.appendChild(li);
            });
        }
    } catch(e) { 
        list.innerHTML = '<li class="text-sm p-4 text-rose-500 text-center">An processing exception halted network sweeps early.</li>';
    }
    btn.disabled = false;
    btn.innerText = "Scan Network";
}

function insertToken(token) {
    const input = document.getElementById('cfg-template');
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const currentText = input.value;
    
    input.value = currentText.substring(0, start) + token + currentText.substring(end);
    input.focus();
    input.selectionStart = input.selectionEnd = start + token.length;
}

// --- Host Filesystem Explorer Controller Logic ---
async function navigateFolder(targetPath = "") {
    const url = `/api/browse?path=${encodeURIComponent(targetPath)}`;
    const list = document.getElementById('modal-folder-list');
    list.innerHTML = '<li class="text-slate-500 text-center p-4 italic">Querying host path...</li>';
    
    try {
        const res = await fetch(url);
        if(!res.ok) {
            // Fallback to default user workspace roots if an assigned directory string fails validation checks
            if (targetPath !== "") {
                navigateFolder("");
                return;
            }
            throw new Error("Could not parse directories.");
        }
        const data = await res.json();
        
        document.getElementById('modal-current-path').value = data.current_path;
        document.getElementById('modal-parent-path').value = data.parent_path;
        
        const upBtn = document.getElementById('btn-folder-up');
        upBtn.disabled = data.current_path === data.parent_path;
        upBtn.style.opacity = upBtn.disabled ? "0.4" : "1";

        if(data.directories.length === 0) {
            list.innerHTML = '<li class="text-slate-500 text-center p-4 italic">This folder contains no subdirectories.</li>';
            return;
        }

        list.innerHTML = '';
        data.directories.forEach(dirName => {
            const li = document.createElement('li');
            const nestedFullPath = `${data.current_path.endsWith('/') || data.current_path.endsWith('\\') ? data.current_path : data.current_path + '/'}${dirName}`;
            li.className = "flex justify-between items-center py-2 px-3 hover:bg-slate-900 text-slate-300 transition group rounded";
            li.innerHTML = `
                <button onclick="navigateFolder('${nestedFullPath.replace(/\\/g, '\\\\')}')" class="text-left w-full flex items-center gap-2 font-medium hover:text-white cursor-pointer truncate">
                    <span>📁</span> <span class="truncate">${dirName}</span>
                </button>
            `;
            list.appendChild(li);
        });
    } catch (e) {
        list.innerHTML = `<li class="text-rose-500 text-center p-4">Error loading structural contents. Check read access variables.</li>`;
    }
}

function openFolderBrowser(inputEl) {
    activeDestinationInput = inputEl;
    document.getElementById('folder-modal').classList.remove('hidden');
    // Seed window with value if it exists, otherwise fall back to system roots
    navigateFolder(inputEl && inputEl.value ? inputEl.value : "");
}

function closeFolderBrowser() {
    document.getElementById('folder-modal').classList.add('hidden');
    activeDestinationInput = null;
}

function selectCurrentFolder() {
    const selected = document.getElementById('modal-current-path').value;
    if (activeDestinationInput) {
        activeDestinationInput.value = selected;
    }
    closeFolderBrowser();
}

// Updates the high-visibility staging HUD display values
function updateLiveStagingHUD(id, title) {
    const hudTitle = document.getElementById('hud-active-title');
    const hudId = document.getElementById('hud-active-id');
    const clearBtn = document.getElementById('btn-clear-context');

    if (!id || id === 'default') {
        hudTitle.innerText = "Default (Time & Date Fallback)";
        hudTitle.className = "text-sm font-medium text-slate-400 italic";
        hudId.innerText = "Filename pattern: YYYYMMDD_HHMM_[DeckName].mov";
        clearBtn.classList.add('hidden');
    } else {
        hudTitle.innerText = title;
        hudTitle.className = "text-sm font-semibold text-white truncate";
        hudId.innerText = `Target Token: {planned_title} ➔ "${title.replace(/\s+/g, '_')}"`;
        clearBtn.classList.remove('hidden');
    }
}

async function selectActiveEventContext(id, plannedTitle) {
    try {
        const response = await fetch('/api/schedule/active', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ id: id, planned_title: plannedTitle })
        });
        
        if (response.ok) {
            globallyActiveEventId = id;
            updateLiveStagingHUD(id, plannedTitle);
            
            // Re-render list to shift row borders and 'LIVE' badges correctly
            const currentItems = [];
            document.querySelectorAll('.schedule-row-item').forEach(el => {
                const schId = el.querySelector('.sch-id').value;
                const schTitle = el.querySelector('.sch-title').value;
                const schDate = el.querySelector('.sch-date')?.value || '';
                const schTime = el.querySelector('.sch-time')?.value || '';
                const schStage = el.querySelector('.sch-stage')?.value || '';
                const schStart = schDate && schTime ? `${schDate} ${schTime}` : '';
                if (schId || schTitle || schStart) {
                    currentItems.push({ id: schId, planned_title: schTitle, start_time: schStart, stage: schStage });
                }
            });
            renderScheduleMatrix(currentItems);
        }
    } catch(e) { console.error("Could not alter active operational tracking channel: ", e); }
}

async function clearActiveEventContext() {
    await selectActiveEventContext('default', '');
}

function createScheduleRowElement(item = { id: '', planned_title: '' }) {
    const startTime = (item.start_time || '').trim();
    const { datePart, timePart } = splitStartTimeParts(startTime);
    const stage = normalizeStageName(item.stage);
    const inScope = isScheduleItemInScope(item);
    const stableRowKey = item._row_key || scheduleItemKey(item) || createTempRowKey();
    const rowKey = encodeURIComponent(stableRowKey);

    const div = document.createElement('div');
    const isActive = item.id && item.id === globallyActiveEventId;
    div.className = `schedule-row-item rounded border px-2.5 py-2.5 ${isActive ? 'border-indigo-500/60 bg-indigo-500/10' : 'border-slate-800 bg-slate-900'}`;
    div.dataset.rowKey = rowKey;
    div.innerHTML = `
        <div class="grid grid-cols-12 gap-2 items-end">
            <label class="col-span-4 text-[10px] text-slate-400 space-y-1">
                <span class="block">Event ID ${hintBadge('Optional. Auto-generated on save if blank.')}</span>
                <input type="text" title="Optional. Auto-generated on save if blank." placeholder="event_001" value="${item.id || ''}" class="sch-id block w-full rounded border border-slate-800 bg-slate-950 px-2 py-1 text-[11px] text-slate-200 focus:outline-none">
            </label>
            <label class="col-span-7 text-[10px] text-slate-400 space-y-1">
                <span class="block">Planned Title ${hintBadge('Human-readable event name used for matching and filename tokens.')}</span>
                <input type="text" title="Human-readable event name used for matching and filename tokens." placeholder="Evening Service" value="${item.planned_title || ''}" class="sch-title block w-full rounded border border-slate-800 bg-slate-950 px-2 py-1 text-[11px] text-slate-200 focus:outline-none">
            </label>
            <button onclick="deleteScheduleRow(this)" class="col-span-1 self-center mt-4 text-rose-400/90 hover:text-rose-300 text-[12px] px-1 cursor-pointer" title="Delete this metadata row">✕</button>
        </div>
        <div class="mt-2 grid grid-cols-12 gap-2 items-end">
            <label class="col-span-4 text-[10px] text-slate-400 space-y-1">
                <span class="block">Date ${hintBadge('Capture date used for schedule matching.')}</span>
                <div class="flex items-center gap-1">
                    <input type="date" title="Capture date used for schedule matching." value="${datePart}" class="sch-date block w-full rounded border border-slate-800 bg-slate-950 px-2 py-1 text-[11px] text-slate-200 focus:outline-none">
                    <button type="button" onclick="openSiblingPicker(this, 'date')" title="Open date picker" class="h-7 w-7 rounded border border-slate-800 bg-slate-950 text-slate-400 hover:text-slate-200 cursor-pointer">📅</button>
                </div>
            </label>
            <label class="col-span-4 text-[10px] text-slate-400 space-y-1">
                <span class="block">Time ${hintBadge('Capture start time used for drift matching.')}</span>
                <div class="flex items-center gap-1">
                    <input type="time" step="60" title="Capture start time used for drift matching." value="${timePart}" class="sch-time block w-full rounded border border-slate-800 bg-slate-950 px-2 py-1 text-[11px] text-slate-200 focus:outline-none">
                    <button type="button" onclick="openSiblingPicker(this, 'time')" title="Open time picker" class="h-7 w-7 rounded border border-slate-800 bg-slate-950 text-slate-400 hover:text-slate-200 cursor-pointer">🕒</button>
                </div>
            </label>
            <label class="col-span-4 text-[10px] text-slate-400 space-y-1">
                <span class="block">Stage ${hintBadge('Optional. Leave blank to match regardless of stage.')}</span>
                <input type="text" list="cfg-stage-options" title="Optional. Leave blank to match regardless of stage." placeholder="Main Stage" value="${stage}" class="sch-stage block w-full rounded border border-slate-800 bg-slate-950 px-2 py-1 text-[11px] text-slate-200 focus:outline-none">
            </label>
        </div>
        <div class="mt-2 flex items-center gap-1.5">
            <span class="text-[10px] ${inScope ? 'text-emerald-300' : 'text-slate-500'}">${inScope ? 'IN SCOPE' : 'OUT OF SCOPE'}</span>
        </div>
        <div class="mt-1.5 flex justify-between items-center text-[10px]">
            <button onclick="selectActiveFromRow(this)" class="text-indigo-400 hover:text-indigo-300 font-medium cursor-pointer">Set Active</button>
            ${isActive ? '<span class="rounded bg-indigo-600/30 px-1.5 py-0.5 text-indigo-300">LIVE</span>' : ''}
        </div>
    `;
    return div;
}

async function deleteScheduleRow(buttonEl) {
    const row = buttonEl.closest('.schedule-row-item');
    if (!row) return;

    const rowKey = decodeURIComponent(row.dataset.rowKey || '');
    const id = row.querySelector('.sch-id')?.value.trim() || '';
    const plannedTitle = row.querySelector('.sch-title')?.value.trim() || '';
    const date = row.querySelector('.sch-date')?.value || '';
    const time = row.querySelector('.sch-time')?.value || '';
    const stage = normalizeStageName(row.querySelector('.sch-stage')?.value || '');
    const start_time = date && time ? `${date} ${time}` : '';
    const fallbackKey = scheduleItemKey({ id, planned_title: plannedTitle, start_time, stage });

    scheduleDataCache = scheduleDataCache.filter(item => {
        const itemKey = item._row_key || scheduleItemKey(item);
        if (rowKey && itemKey === rowKey) return false;
        if (!rowKey && fallbackKey && itemKey === fallbackKey) return false;
        return true;
    });

    row.remove();
    await saveScheduleFromMatrix();
}

function renderScheduleMatrix(schedule = [], preserveCache = false) {
    const container = document.getElementById('schedule-matrix-container');
    container.innerHTML = '';

    if (!preserveCache) {
        scheduleDataCache = Array.isArray(schedule) ? schedule.map(item => ({ ...item })) : [];
    }

    const fullSchedule = scheduleDataCache;
    const filteredSchedule = applyScheduleScopeFilter(fullSchedule);

    if (!Array.isArray(fullSchedule) || fullSchedule.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'text-[11px] text-slate-500 italic px-1 py-1';
        empty.innerText = currentPluginSelection ? 'No schedule mappings loaded. Append rows manually or sync a plugin.' : 'Manual mode is active. Append rows below to build the schedule.';
        container.appendChild(empty);
        document.getElementById('sync-counter').innerText = '0 records';
        return;
    }

    updateStageSuggestionUI(fullSchedule);

    if (filteredSchedule.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'text-[11px] text-slate-500 italic px-1 py-1';
        empty.innerText = 'No rows match current stage scope filter.';
        container.appendChild(empty);
    } else {
        filteredSchedule.forEach(item => container.appendChild(createScheduleRowElement(item)));
    }

    if (scheduleFilterMode === 'in_scope') {
        document.getElementById('sync-counter').innerText = `${filteredSchedule.length}/${fullSchedule.length} in scope`;
    } else {
        document.getElementById('sync-counter').innerText = `${fullSchedule.length} records`;
    }
}

async function saveScheduleFromMatrix() {
    mergeVisibleRowsIntoCache();
    const normalizedRows = scheduleDataCache
        .map((row, idx) => {
            const plannedTitle = (row.planned_title || '').trim();
            const start_time = (row.start_time || '').trim();
            const stage = normalizeStageName(row.stage);
            let id = (row.id || '').trim();
            const stableKey = (row._row_key || row._key || scheduleItemKey(row) || createTempRowKey()).toString();

            if (!id && start_time) {
                const safeTitle = (plannedTitle || `event_${idx + 1}`).replace(/\s+/g, '_').replace(/[^\w\-]/g, '').toLowerCase();
                id = `${start_time}_${safeTitle}`;
            }
            return { _row_key: stableKey, id, planned_title: plannedTitle, start_time, stage };
        })
        .filter(row => row.id || row.planned_title || row.start_time);

    scheduleDataCache = normalizedRows;
    const payload = normalizedRows.map(({ id, planned_title, start_time, stage }) => ({ id, planned_title, start_time, stage }));

    await fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    renderScheduleMatrix(scheduleDataCache, true);

    const syncStatus = document.getElementById('plugin-sync-status');
    if (!currentPluginSelection) {
        const descriptionEl = document.getElementById('plugin-description');
        descriptionEl.innerText = 'Manual mode active. Rows below are maintained by hand.';
        syncStatus.innerText = `Manual schedule saved. ${payload.length} row${payload.length === 1 ? '' : 's'} in manual mode.`;
    } else {
        syncStatus.innerText = `Schedule changes saved. ${payload.length} row${payload.length === 1 ? '' : 's'} now active.`;
    }
}

function requestScheduleSaveDebounced() {
    if (scheduleSaveDebounceTimer) {
        clearTimeout(scheduleSaveDebounceTimer);
    }

    scheduleSaveDebounceTimer = setTimeout(async () => {
        scheduleSaveDebounceTimer = null;
        try {
            await saveScheduleFromMatrix();
        } catch (e) {
            const syncStatus = document.getElementById('plugin-sync-status');
            syncStatus.innerText = 'Schedule autosave failed. Use Save Schedule Changes.';
        }
    }, 700);
}

function addManualScheduleRow() {
    mergeVisibleRowsIntoCache();
    scheduleDataCache.push({
        _row_key: createTempRowKey(),
        id: '',
        planned_title: '',
        start_time: '',
        stage: '',
    });
    renderScheduleMatrix(scheduleDataCache, true);
}

async function selectActiveFromRow(buttonEl) {
    const row = buttonEl.closest('.schedule-row-item');
    if (!row) return;

    const id = row.querySelector('.sch-id').value.trim();
    const plannedTitle = row.querySelector('.sch-title').value.trim();
    const date = row.querySelector('.sch-date')?.value || '';
    const time = row.querySelector('.sch-time')?.value || '';
    const startTime = date && time ? `${date} ${time}` : '';
    if (!id && !startTime) {
        alert('Please set an event ID before selecting active context.');
        return;
    }

    await saveScheduleFromMatrix();
    await selectActiveEventContext(id || startTime, plannedTitle);
}

async function triggerPluginSync() {
    const selector = document.getElementById('plugin-selector');
    const plugin = selector.value;
    const syncStatus = document.getElementById('plugin-sync-status');
    const syncButton = document.getElementById('btn-plugin-sync');

    if (!plugin) {
        alert('Select a schedule plugin first.');
        return;
    }

    const selectedPlugin = availablePlugins.find(p => p.name === plugin);
    if (selectedPlugin?.supports_upload) {
        syncStatus.innerText = 'This plugin uses file upload. Choose an .xlsx file and click Upload.';
        return;
    }

    try {
        syncButton.disabled = true;
        syncButton.innerText = 'Syncing...';
        syncStatus.innerText = `Running plugin: ${plugin}`;

        const res = await fetch(`/api/plugins/run/${encodeURIComponent(plugin)}`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) {
            alert(data.detail || 'Plugin sync failed.');
            syncStatus.innerText = `Sync failed: ${data.detail || 'Unknown plugin error'}`;
            return;
        }

        const scheduleRes = await fetch('/api/schedule');
        const schedule = await scheduleRes.json();
        renderScheduleMatrix(schedule);

        const count = Array.isArray(schedule) ? schedule.length : 0;
        syncStatus.innerText = `Last sync: ${count} rows loaded from ${plugin}`;
    } catch (e) {
        alert('Plugin sync request failed.');
        syncStatus.innerText = 'Sync failed: Could not reach server plugin endpoint.';
    } finally {
        syncButton.disabled = false;
        syncButton.innerText = '🔄 Fetch & Sync Schedule';
    }
}

async function uploadScheduleFile() {
    const selector = document.getElementById('plugin-selector');
    const plugin = selector.value;
    const fileInput = document.getElementById('plugin-file-input');
    const uploadStatus = document.getElementById('plugin-upload-status');
    const uploadButton = document.getElementById('btn-plugin-upload');

    if (!plugin) {
        alert('Select a plugin first.');
        return;
    }

    const file = fileInput.files && fileInput.files[0];
    if (!file) {
        alert('Choose an .xlsx file first.');
        return;
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
        uploadButton.disabled = true;
        uploadButton.innerText = 'Uploading...';
        uploadStatus.innerText = `Uploading ${file.name}...`;

        const res = await fetch(`/api/plugins/upload/${encodeURIComponent(plugin)}`, {
            method: 'POST',
            body: formData,
        });
        const data = await res.json();

        if (!res.ok) {
            uploadStatus.innerText = `Upload failed: ${data.detail || 'Unknown error'}`;
            return;
        }

        const scheduleRes = await fetch('/api/schedule');
        const schedule = await scheduleRes.json();
        renderScheduleMatrix(schedule);
        uploadStatus.innerText = `Upload complete. ${Array.isArray(schedule) ? schedule.length : 0} rows loaded.`;
    } catch (e) {
        uploadStatus.innerText = 'Upload failed: Could not reach server.';
    } finally {
        uploadButton.disabled = false;
        uploadButton.innerText = 'Upload';
    }
}

async function clearScheduleForManualMode() {
    scheduleDataCache = [];
    await fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([])
    });
    renderScheduleMatrix([]);
}

function updatePluginDetails() {
    const selector = document.getElementById('plugin-selector');
    const descriptionEl = document.getElementById('plugin-description');
    const syncStatus = document.getElementById('plugin-sync-status');
    const syncButton = document.getElementById('btn-plugin-sync');
    const uploadPanel = document.getElementById('plugin-upload-panel');
    const uploadStatus = document.getElementById('plugin-upload-status');
    const fileInput = document.getElementById('plugin-file-input');

    const selectedName = selector.value;
    if (!selectedName) {
        descriptionEl.innerText = 'Manual mode active. Add and save schedule rows directly below.';
        syncButton.disabled = true;
        syncButton.innerText = 'Manual Mode';
        syncButton.classList.add('opacity-50', 'cursor-not-allowed');
        syncStatus.innerText = 'Manual mode active. Plugin schedule has been cleared.';
        uploadPanel.classList.add('hidden');
        if (fileInput) fileInput.value = '';
        uploadStatus.innerText = 'No file uploaded yet.';
        return;
    }

    const selectedPlugin = availablePlugins.find(p => p.name === selectedName);
    descriptionEl.innerText = selectedPlugin?.description || 'No plugin description available.';
    syncButton.disabled = selectedPlugin?.enabled === false;
    syncButton.classList.remove('opacity-50', 'cursor-not-allowed');
    syncButton.innerText = '🔄 Fetch & Sync Schedule';
    const supportsUpload = !!selectedPlugin?.supports_upload;
    uploadPanel.classList.toggle('hidden', !supportsUpload);
    if (supportsUpload) {
        syncButton.disabled = true;
        syncButton.innerText = 'Use Upload Below';
        syncButton.classList.add('opacity-50', 'cursor-not-allowed');
        syncStatus.innerText = 'Upload an .xlsx file below to import and sync schedule.';
    }
    if (!supportsUpload) {
        if (fileInput) fileInput.value = '';
        uploadStatus.innerText = 'No file uploaded yet.';
    }
}

// --- HyperDeck Transport Controls ---

/** Send a record or stop command to a single deck and surface feedback to the user. */
async function sendDeckCommand(host, command) {
    const label = command === 'record' ? '⏺ Recording' : '⏹ Stopped';
    try {
        const res = await fetch(`/api/control/${encodeURIComponent(host)}/${command}`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) {
            alert(`Command failed on ${host}: ${data.detail || 'Unknown error'}`);
        } else {
            console.info(`${label} on ${host}:`, data.response);
        }
    } catch (e) {
        alert(`Could not reach HyperDeck at ${host}.`);
    }
}

/**
 * Send a record or stop command to ALL configured decks and surface a summary.
 * @param {'record'|'stop'} command
 */
async function sendCommandToAll(command) {
    const label = command === 'record' ? 'Record All' : 'Stop All';
    const btnId = command === 'record' ? 'btn-record-all' : 'btn-stop-all';
    const btn = document.getElementById(btnId);
    if (btn) {
        btn.disabled = true;
        btn.innerText = command === 'record' ? '⏺ Recording…' : '⏹ Stopping…';
    }
    try {
        const res = await fetch(`/api/control/all/${command}`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) {
            alert(`${label} failed: ${data.detail || 'Unknown error'}`);
            return;
        }
        const results = data.results || [];
        const failed = results.filter(r => !r.success);
        if (failed.length > 0) {
            const names = failed.map(r => r.name || r.host).join(', ');
            alert(`${label}: command failed on ${failed.length} deck(s): ${names}`);
        }
    } catch (e) {
        alert(`${label}: could not reach server.`);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = command === 'record' ? '⏺ Record All' : '⏹ Stop All';
        }
    }
}

// --- Deck Settings Modal ---

let activeDeckSettingsHost = '';
let activeDeckSettingsName = '';

async function openDeckSettings(host, name) {
    activeDeckSettingsHost = host;
    activeDeckSettingsName = name;
    const modal = document.getElementById('deck-settings-modal');
    const hostLabel = document.getElementById('deck-settings-host');
    const loadingEl = document.getElementById('deck-settings-loading');
    const formEl = document.getElementById('deck-settings-form');
    const errorEl = document.getElementById('deck-settings-error');
    const saveBtn = document.getElementById('btn-save-deck-settings');
    const statusEl = document.getElementById('deck-settings-status');

    hostLabel.innerText = `${name} — ${host}`;
    loadingEl.classList.remove('hidden');
    formEl.classList.add('hidden');
    errorEl.classList.add('hidden');
    saveBtn.classList.add('hidden');
    if (statusEl) statusEl.innerText = '';
    modal.classList.remove('hidden');

    // Reset selects to "unchanged"
    ['ds-file-format', 'ds-video-input', 'ds-audio-input', 'ds-audio-codec'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });

    try {
        const res = await fetch(`/api/control/${encodeURIComponent(host)}/configuration`);
        const data = await res.json();

        loadingEl.classList.add('hidden');

        if (!res.ok) {
            errorEl.innerText = data.detail || 'Failed to load configuration.';
            errorEl.classList.remove('hidden');
            return;
        }

        const settings = data.settings || {};
        _renderCurrentSettingsPanel(settings);

        // Pre-fill selects with current values if they match an option
        const fieldMap = {
            'file format': 'ds-file-format',
            'video input': 'ds-video-input',
            'audio input': 'ds-audio-input',
            'audio codec': 'ds-audio-codec',
        };
        Object.entries(fieldMap).forEach(([settingKey, elId]) => {
            const val = settings[settingKey];
            if (!val) return;
            const select = document.getElementById(elId);
            if (!select) return;
            const optionExists = Array.from(select.options).some(o => o.value === val);
            select.value = optionExists ? val : '';
        });

        formEl.classList.remove('hidden');
        saveBtn.classList.remove('hidden');
    } catch (e) {
        loadingEl.classList.add('hidden');
        errorEl.innerText = `Could not reach HyperDeck at ${host}.`;
        errorEl.classList.remove('hidden');
    }
}

function closeDeckSettings() {
    document.getElementById('deck-settings-modal').classList.add('hidden');
    activeDeckSettingsHost = '';
    activeDeckSettingsName = '';
}

async function saveDeckSettings() {
    if (!activeDeckSettingsHost) return;
    const requestHost = activeDeckSettingsHost;
    const statusEl = document.getElementById('deck-settings-status');
    const saveBtn = document.getElementById('btn-save-deck-settings');

    const settings = {};
    const fieldMap = {
        'ds-file-format': 'file format',
        'ds-video-input': 'video input',
        'ds-audio-input': 'audio input',
        'ds-audio-codec': 'audio codec',
    };
    Object.entries(fieldMap).forEach(([elId, key]) => {
        const el = document.getElementById(elId);
        if (el && el.value) settings[key] = el.value;
    });

    if (Object.keys(settings).length === 0) {
        if (statusEl) statusEl.innerText = 'No changes selected.';
        return;
    }

    saveBtn.disabled = true;
    saveBtn.innerText = 'Applying…';
    if (statusEl) statusEl.innerText = '';

    try {
        const res = await fetch(`/api/control/${encodeURIComponent(requestHost)}/configuration`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings),
        });
        const data = await res.json();

        if (!res.ok) {
            if (statusEl) statusEl.innerText = `Error: ${data.detail || 'Unknown error'}`;
            return;
        }

        const failed = (data.results || []).filter(r => !r.success);
        if (failed.length > 0) {
            if (statusEl) statusEl.innerText = `${failed.length} setting(s) rejected by device.`;
        } else {
            if (statusEl) statusEl.innerText = 'Settings applied successfully.';
            // Refresh only the current-values panel by re-fetching configuration.
            // This avoids resetting the selects and reopening the whole modal.
            try {
                const cfgRes = await fetch(`/api/control/${encodeURIComponent(requestHost)}/configuration`);
                if (cfgRes.ok) {
                    const cfgData = await cfgRes.json();
                    if (activeDeckSettingsHost === requestHost) {
                        _renderCurrentSettingsPanel(cfgData.settings || {});
                    }
                }
            } catch (_) { /* non-critical — stale values are acceptable */ }
        }
    } catch (e) {
        if (statusEl) statusEl.innerText = 'Could not reach HyperDeck.';
    } finally {
        saveBtn.disabled = false;
        saveBtn.innerText = 'Apply Settings';
    }
}

function _renderCurrentSettingsPanel(settings) {
    const currentEl = document.getElementById('deck-settings-current');
    if (!currentEl) return;
    const LABELS = {
        'file format': 'File Format',
        'video input': 'Video Input',
        'audio input': 'Audio Input',
        'audio codec': 'Audio Codec',
        'timecode input': 'Timecode Input',
        'timecode output': 'Timecode Output',
    };
    let html = '<span class="block font-semibold text-slate-500 tracking-wide uppercase text-[10px] mb-1.5">Current Device Values</span>';
    const knownKeys = Object.keys(LABELS);
    knownKeys.forEach(key => {
        if (settings[key] !== undefined) {
            // LABELS[key] is a static string — escHtml applied to the device value only
            html += `<div class="flex justify-between"><span class="text-slate-500">${LABELS[key]}</span><span class="text-slate-300">${escHtml(settings[key])}</span></div>`;
        }
    });
    Object.keys(settings).filter(k => !knownKeys.includes(k)).forEach(key => {
        // Both key and value come from the device — escape both
        html += `<div class="flex justify-between"><span class="text-slate-500">${escHtml(key)}</span><span class="text-slate-300">${escHtml(settings[key])}</span></div>`;
    });
    if (Object.keys(settings).length === 0) {
        html += '<div class="text-slate-500 italic">No configuration data returned.</div>';
    }
    currentEl.innerHTML = html;
}

// Expose handlers for inline onclick attributes in index.html.
Object.assign(window, {
    triggerDiscovery,
    addDestinationRow,
    insertToken,
    addDeckToConfigRow,
    saveConfigToServer,
    openFolderBrowser,
    closeFolderBrowser,
    navigateFolder,
    selectCurrentFolder,
    clearActiveEventContext,
    triggerPluginSync,
    addManualScheduleRow,
    selectActiveFromRow,
    saveScheduleFromMatrix,
    uploadScheduleFile,
    openNativePicker,
    openSiblingPicker,
    sendDeckCommand,
    sendCommandToAll,
    openDeckSettings,
    closeDeckSettings,
    saveDeckSettings,
});

// Update your primary load sequence to populate the HUD card on application bootup
async function loadPluginManagerSystem() {
    try {
        const pluginRes = await fetch('/api/plugins');
        const plugins = await pluginRes.json();
        availablePlugins = Array.isArray(plugins) ? plugins : [];
        const selector = document.getElementById('plugin-selector');

        availablePlugins.forEach(p => {
            const opt = document.createElement('option');
            if (typeof p === 'string') {
                opt.value = p;
                opt.innerText = p.replace(/_/g, ' ').toUpperCase();
            } else {
                opt.value = p.name;
                opt.innerText = p.enabled === false ? `${p.label} (Unavailable)` : p.label;
                opt.disabled = p.enabled === false;
            }
            selector.appendChild(opt);
        });

        const savedSelection = localStorage.getItem(PLUGIN_SELECTION_STORAGE_KEY) || '';
        const savedExists = availablePlugins.some(p => (typeof p === 'string' ? p : p.name) === savedSelection);
        selector.value = savedExists ? savedSelection : '';

        if (!selector.dataset.bound) {
            selector.addEventListener('change', async () => {
                const nextSelection = selector.value;
                const switchedToManual = currentPluginSelection && !nextSelection;
                currentPluginSelection = nextSelection;
                localStorage.setItem(PLUGIN_SELECTION_STORAGE_KEY, nextSelection);
                if (switchedToManual) {
                    await clearScheduleForManualMode();
                }
                updatePluginDetails();
            });
            selector.dataset.bound = 'true';
        }
        currentPluginSelection = selector.value;
        updatePluginDetails();

        const scopeFilter = document.getElementById('schedule-scope-filter');
        if (!scopeFilter.dataset.bound) {
            scopeFilter.addEventListener('change', () => {
                scheduleFilterMode = scopeFilter.value;
                mergeVisibleRowsIntoCache();
                renderScheduleMatrix(scheduleDataCache, true);
            });
            scopeFilter.dataset.bound = 'true';
        }
        scheduleFilterMode = scopeFilter.value;

        const scheduleContainer = document.getElementById('schedule-matrix-container');
        if (!scheduleContainer.dataset.bound) {
            scheduleContainer.addEventListener('input', (event) => {
                const target = event.target;
                if (!(target instanceof HTMLElement)) return;
                if (target.closest('.schedule-row-item')) {
                    if (target.classList.contains('sch-date') || target.classList.contains('sch-time')) {
                        return;
                    }
                    mergeVisibleRowsIntoCache();
                    requestScheduleSaveDebounced();
                }
            });
            scheduleContainer.addEventListener('change', (event) => {
                const target = event.target;
                if (!(target instanceof HTMLElement)) return;
                if (target.closest('.schedule-row-item')) {
                    mergeVisibleRowsIntoCache();
                    requestScheduleSaveDebounced();
                }
            });
            scheduleContainer.dataset.bound = 'true';
        }

        // Pull active server token state and force updates to HUD card
        const activeContextRes = await fetch('/api/schedule/active');
        const activeContext = await activeContextRes.json();
        globallyActiveEventId = activeContext.id;
        updateLiveStagingHUD(activeContext.id, activeContext.planned_title);

        const dataRes = await fetch('/api/schedule');
        const schedule = await dataRes.json();
        renderScheduleMatrix(schedule);
    } catch(e) { console.error("Could not synchronize core schedule interface modules: ", e); }
}

// Application execution setups
pullConfigurationMatrix();
setInterval(updateDashboardMetrics, 2000);
updateDashboardMetrics();
loadPluginManagerSystem();