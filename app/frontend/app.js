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
let deckSettingsLastFocusedElement = null;
let settingsGroupsOptionSuggestionsCache = {};

const SLATE_FIELD_CONFIG = [
    { key: 'reel', label: 'Reel', type: 'number', min: '1', max: '999', placeholder: '1-999' },
    { key: 'scene id', label: 'Scene ID', type: 'text', placeholder: 'e.g. 12A' },
    { key: 'shot type', label: 'Shot Type', type: 'select', options: ['', 'WS', 'MS', 'CU', 'BCU', 'MCU', 'ECU', 'none'] },
    { key: 'take', label: 'Take', type: 'number', min: '1', max: '99', placeholder: '1-99' },
    { key: 'take scenario', label: 'Take Scenario', type: 'select', options: ['', 'PU', 'VFX', 'SER', 'none'] },
    { key: 'take auto inc', label: 'Take Auto Increment', type: 'select', options: ['', 'true', 'false'] },
    { key: 'good take', label: 'Good Take', type: 'select', options: ['', 'true', 'false'] },
    { key: 'environment', label: 'Environment', type: 'select', options: ['', 'interior', 'exterior'] },
    { key: 'day night', label: 'Day/Night', type: 'select', options: ['', 'day', 'night'] },
    { key: 'project name', label: 'Project Name', type: 'text', placeholder: 'Project name' },
    { key: 'camera', label: 'Camera', type: 'text', placeholder: 'A' },
    { key: 'director', label: 'Director', type: 'text', placeholder: 'Director name' },
    { key: 'camera operator', label: 'Camera Operator', type: 'text', placeholder: 'Operator name' },
];

function slateFieldClassName(prefix, key) {
    return `${prefix}-slate-${String(key || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function buildSlateMetadataFromContainer(root, prefix) {
    const metadata = {};
    if (!root) return metadata;

    SLATE_FIELD_CONFIG.forEach((field) => {
        const el = root.querySelector(`.${slateFieldClassName(prefix, field.key)}`);
        if (!el) return;
        const value = String(el.value || '').trim();
        if (value) metadata[field.key] = value;
    });

    return metadata;
}

function setSlateMetadataInContainer(root, prefix, metadata = {}) {
    if (!root) return;
    SLATE_FIELD_CONFIG.forEach((field) => {
        const el = root.querySelector(`.${slateFieldClassName(prefix, field.key)}`);
        if (!el) return;
        el.value = String((metadata && metadata[field.key]) || '');
    });
}

function renderSlateFieldInputs(containerId, prefix, metadata = {}, compact = false) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const colClass = compact ? 'col-span-2' : 'col-span-1';
    const html = SLATE_FIELD_CONFIG.map((field, idx) => {
        const klass = slateFieldClassName(prefix, field.key);
        const current = escHtml(String((metadata && metadata[field.key]) || ''));
        const hiddenClass = idx >= 4 ? 'slate-extra hidden' : '';

        if (field.type === 'select') {
            const options = (field.options || []).map((option) => {
                const selected = String(option) === String((metadata && metadata[field.key]) || '') ? 'selected' : '';
                const label = option || '— unchanged —';
                return `<option value="${escHtml(option)}" ${selected}>${escHtml(label)}</option>`;
            }).join('');

            return `
                <label class="${colClass} ${hiddenClass} text-xs text-slate-400 space-y-1">
                    <span class="block">${escHtml(field.label)}</span>
                    <select class="${klass} block w-full rounded bg-slate-950 border border-slate-800 text-xs px-2 py-1.5 text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500">
                        ${options}
                    </select>
                </label>
            `;
        }

        const attrs = [
            field.min ? `min="${field.min}"` : '',
            field.max ? `max="${field.max}"` : '',
            field.placeholder ? `placeholder="${escHtml(field.placeholder)}"` : '',
        ].filter(Boolean).join(' ');

        return `
            <label class="${colClass} ${hiddenClass} text-xs text-slate-400 space-y-1">
                <span class="block">${escHtml(field.label)}</span>
                <input type="${field.type}" value="${current}" ${attrs} class="${klass} block w-full rounded border border-slate-800 bg-slate-950 text-xs px-2 py-1.5 text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500">
            </label>
        `;
    }).join('');

    container.innerHTML = `
        <div class="grid grid-cols-2 gap-3">${html}</div>
        <div class="mt-1 flex justify-end">
            <button type="button" onclick="toggleSlateFields(this)" class="text-[10px] text-indigo-400 hover:text-indigo-300 font-medium cursor-pointer">Show all fields</button>
        </div>
    `;
}

function toggleSlateFields(buttonEl) {
    const root = buttonEl.closest('div');
    if (!root) return;
    const extras = root.querySelectorAll('.slate-extra');
    if (!extras.length) return;
    const shouldShow = Array.from(extras).some((el) => el.classList.contains('hidden'));
    extras.forEach((el) => el.classList.toggle('hidden', !shouldShow));
    buttonEl.innerText = shouldShow ? 'Show fewer fields' : 'Show all fields';
}

function toggleEventSlateFields(buttonEl) {
    const row = buttonEl.closest('.schedule-row-item');
    if (!row) return;
    const extras = row.querySelectorAll('.sch-slate-extra');
    if (!extras.length) return;
    const shouldShow = Array.from(extras).some((el) => el.classList.contains('hidden'));
    extras.forEach((el) => el.classList.toggle('hidden', !shouldShow));
    buttonEl.innerText = shouldShow ? 'Show fewer fields' : 'Show all fields';
}

function toggleDeckSlateSection(section) {
    const className = section === 'project' ? '.ds-slate-project-extra' : '.ds-slate-clip-extra';
    const buttonId = section === 'project' ? 'btn-ds-toggle-project-slate' : 'btn-ds-toggle-clip-slate';
    const button = document.getElementById(buttonId);
    const extras = document.querySelectorAll(className);
    if (!button || !extras.length) return;
    const shouldShow = Array.from(extras).some((el) => el.classList.contains('hidden'));
    extras.forEach((el) => el.classList.toggle('hidden', !shouldShow));
    button.innerText = shouldShow ? 'Show fewer fields' : 'Show all fields';
}

function applySettingsGroupsScopePreset(preset) {
    const presets = {
        timecode: ['timecode input', 'timecode output', 'timecode preset'],
        audio: ['audio input', 'audio codec', 'audio input channels', 'audio meters'],
        slate: ['reel', 'scene id', 'shot type', 'take', 'take scenario', 'take auto inc', 'good take', 'environment', 'day night', 'project name', 'camera', 'director', 'camera operator'],
        video: ['file format', 'video input', 'default standard'],
    };

    const selected = new Set((presets[preset] || []).map((k) => String(k).toLowerCase()));
    document.querySelectorAll('.sg-scope-field-checkbox').forEach((el) => {
        const key = String(el.value || '').trim().toLowerCase();
        el.checked = selected.has(key);
    });
}
let deckSettingsGroupsCache = {};
let settingsGroupsLastFocusedElement = null;

function formatDeckOptionsSourceLabel(source) {
    return source === 'device'
        ? 'device-reported'
        : (source === 'model_profile_preferred'
            ? 'model capability profile (preferred)'
            : (source === 'device+model'
                ? 'device + model profile fallback'
                : (source === 'device_partial'
                    ? 'device-reported (partial enumeration)'
                    : (source === 'model_profile'
                        ? 'model profile fallback'
                        : 'current-values-only'))));
}

function currentSettingsGroupsFieldValues() {
    return document.getElementById('sg-settings-fields') ? collectSettingsGroupsFieldSettings() : {};
}

function getSettingsGroupsSuggestionHost() {
    const selectedTargets = selectedSettingsGroupsTargets();
    if (selectedTargets.length > 0) return selectedTargets[0];

    const configuredHosts = Object.values(localConfigCache.hyperdecks || {}).map((host) => String(host || '').trim()).filter(Boolean);
    return configuredHosts[0] || '';
}

function settingsGroupsSuggestionSourceLabel(host, source) {
    if (!host) return '';
    const entries = Object.entries(localConfigCache.hyperdecks || {});
    const match = entries.find(([, value]) => String(value || '').trim() === String(host));
    const deckName = match ? String(match[0] || '').trim() : '';
    const prefix = deckName ? `${deckName} (${host})` : host;
    return `${prefix} · ${formatDeckOptionsSourceLabel(source)}`;
}

async function loadSettingsGroupsOptionSuggestions(host) {
    const normalizedHost = String(host || '').trim();
    if (!normalizedHost) return { host: '', options: {}, sourceLabel: '' };
    if (settingsGroupsOptionSuggestionsCache[normalizedHost]) return settingsGroupsOptionSuggestionsCache[normalizedHost];

    try {
        const res = await fetch(`/api/control/${encodeURIComponent(normalizedHost)}/configuration`);
        if (!res.ok) throw new Error('fetch failed');
        const data = await res.json();
        const payload = {
            host: normalizedHost,
            options: (data && typeof data.options === 'object' && data.options) ? data.options : {},
            sourceLabel: settingsGroupsSuggestionSourceLabel(normalizedHost, String(data?.options_source || '')),
        };
        settingsGroupsOptionSuggestionsCache[normalizedHost] = payload;
        return payload;
    } catch (_) {
        return { host: normalizedHost, options: {}, sourceLabel: '' };
    }
}

async function refreshSettingsGroupsOptionSuggestions(settingsOverride = null) {
    const host = getSettingsGroupsSuggestionHost();
    const currentSettings = settingsOverride || currentSettingsGroupsFieldValues();
    if (!host) {
        renderSettingsGroupsFieldEditor(currentSettings, {}, '');
        return;
    }

    const { options, sourceLabel } = await loadSettingsGroupsOptionSuggestions(host);
    renderSettingsGroupsFieldEditor(currentSettings, options, sourceLabel);
}

function onSettingsGroupsTargetSelectionChanged() {
    void refreshSettingsGroupsOptionSuggestions();
}

const DECK_SETTINGS_SCOPE_OPTIONS = [
    { key: 'file format', label: 'File Format' },
    { key: 'video input', label: 'Video Input' },
    { key: 'audio input', label: 'Audio Input' },
    { key: 'audio codec', label: 'Audio Codec' },
    { key: 'default standard', label: 'Default Standard' },
    { key: 'audio input channels', label: 'Audio Channels' },
    { key: 'timecode input', label: 'Timecode Input' },
    { key: 'timecode output', label: 'Timecode Output' },
    { key: 'timecode preset', label: 'Timecode Preset' },
    { key: 'audio meters', label: 'Audio Meters' },
    { key: 'reel', label: 'Reel' },
    { key: 'scene id', label: 'Scene ID' },
    { key: 'shot type', label: 'Shot Type' },
    { key: 'take', label: 'Take' },
    { key: 'take scenario', label: 'Take Scenario' },
    { key: 'take auto inc', label: 'Take Auto Inc' },
    { key: 'good take', label: 'Good Take' },
    { key: 'environment', label: 'Environment' },
    { key: 'day night', label: 'Day/Night' },
    { key: 'project name', label: 'Project Name' },
    { key: 'camera', label: 'Camera' },
    { key: 'director', label: 'Director' },
    { key: 'camera operator', label: 'Camera Operator' },
];

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

function insertEventSlateTemplate(buttonEl) {
    const row = buttonEl.closest('.schedule-row-item');
    if (!row) return;

    const existing = buildSlateMetadataFromContainer(row, 'sch');

    // Fill only missing keys so user-entered values are preserved.
    const template = {
        'scene id': '',
        'shot type': 'none',
        'take': '1',
        'take scenario': 'none',
        'take auto inc': 'false',
        'good take': 'false',
        'environment': 'interior',
        'day night': 'day',
    };

    const merged = { ...template, ...existing };
    setSlateMetadataInContainer(row, 'sch', merged);
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
        const slate_metadata = buildSlateMetadataFromContainer(el, 'sch');

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
            slate_metadata,
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
            slate_metadata: row.slate_metadata || {},
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
    if (!safe.slate_metadata || typeof safe.slate_metadata !== 'object') safe.slate_metadata = {};
    if (!safe.slate_metadata.global || typeof safe.slate_metadata.global !== 'object') safe.slate_metadata.global = {};
    if (!safe.slate_metadata.per_deck || typeof safe.slate_metadata.per_deck !== 'object') safe.slate_metadata.per_deck = {};
    if (!safe.slate_metadata.per_event || typeof safe.slate_metadata.per_event !== 'object') safe.slate_metadata.per_event = {};
    if (!safe.stage_mode || !['global', 'per_deck'].includes(safe.stage_mode)) safe.stage_mode = 'global';
    if (typeof safe.global_stage !== 'string') safe.global_stage = '';
    if (typeof safe.schedule_auto_mode !== 'boolean') safe.schedule_auto_mode = true;
    if (typeof safe.schedule_max_drift_minutes !== 'number') safe.schedule_max_drift_minutes = 45;
    if (typeof safe.filename_template !== 'string') safe.filename_template = '{year}{month}{day}_{planned_title}';
    return safe;
}

function insertSlateGlobalTemplate() {
    const container = document.getElementById('cfg-slate-global-fields');
    if (!container) return;
    const existing = buildSlateMetadataFromContainer(container, 'cfg-global');

    const template = {
        'project name': 'Production Name',
        'director': 'Director Name',
        'camera operator': '',
    };
    setSlateMetadataInContainer(container, 'cfg-global', { ...template, ...existing });
}

function insertSlatePerDeckTemplate() {
    // Kept for backwards compatibility with existing button bindings if any remain.
    alert('Per-deck slate metadata is configured in each Deck Settings panel.');
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
        if (!res.ok) return;
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
        let allRecording = true;
        let anyRecording = false;
        for (const [ip, item] of Object.entries(state)) {
            const transportStatus = String(item.transport_status || item.status || '').toLowerCase();
            const isRecording = transportStatus === 'recording' || transportStatus === 'record' || transportStatus.startsWith('record');
            const isPlaying = transportStatus === 'playing' || transportStatus === 'play' || transportStatus === 'forward';
            if (!isRecording) allRecording = false;
            if (isRecording) anyRecording = true;
            const pulseClass = isRecording
                ? 'bg-red-500 animate-pulse'
                : (isPlaying ? 'bg-sky-500 animate-pulse' : (item.connected ? 'bg-emerald-500' : 'bg-rose-500'));
            const badgeClass = isRecording
                ? 'bg-red-500/20 text-red-300 border-red-500/30'
                : (isPlaying ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' : 'bg-slate-800 text-slate-300 ring-slate-700');
            const statusLabel = item.connected ? (item.status === 'Online' ? 'Online' : item.status) : item.status;
            // JSON literals are HTML-escaped before inserting into inline attributes.
            const jsIpAttr = escHtml(JSON.stringify(ip));
            const jsNameAttr = escHtml(JSON.stringify(item.name || ''));
            const parsedProgress = parseInt(item.progress, 10);
            const progressPct = Number.isFinite(parsedProgress) ? Math.max(0, Math.min(100, parsedProgress)) : 0;
            const transferEta = formatEtaSeconds(item.transfer_eta_seconds);
            const playbackSchedule = item.playback_schedule || {};
            const playbackScheduleState = String(playbackSchedule.state || 'idle');
            const playbackScheduleAt = playbackSchedule.play_at ? new Date(playbackSchedule.play_at).toLocaleString() : '';
            
            html += `
            <div class="rounded-lg border border-slate-800 bg-slate-900 p-5 shadow-sm">
                <div class="flex items-center justify-between mb-4">
                    <div>
                        <h3 class="font-semibold text-white text-base">${escHtml(item.name)}</h3>
                        <p class="text-xs text-slate-400 font-mono">${escHtml(ip)}</p>
                    </div>
                    <span class="inline-flex items-center gap-x-1.5 rounded-full px-2 py-1 text-xs font-medium border ${badgeClass}">
                        <svg class="h-1.5 w-1.5 ${pulseClass} rounded-full" viewBox="0 0 6 6" aria-hidden="true"><circle cx="3" cy="3" r="3" /></svg>
                        ${escHtml(statusLabel)}
                    </span>
                </div>
                ${item.stage ? `<div class="text-[11px] text-indigo-300 mb-2">Stage: ${escHtml(item.stage)}</div>` : ''}
                ${(item.transport_status && String(item.transport_status) !== String(statusLabel)) ? `<div class="text-[11px] text-slate-300 mb-1">Transport: <span class="text-white">${escHtml(item.transport_status)}</span></div>` : ''}
                ${item.next_event ? `<div class="text-[11px] text-slate-300 mb-1">Next: <span class="text-white">${escHtml(item.next_event.planned_title || 'Unnamed Event')}</span> (${escHtml(item.next_event.start_time || 'No time')})</div>` : '<div class="text-[11px] text-slate-500 mb-1">Next: No matching schedule event found</div>'}
                ${item.matched_event ? `<div class="text-[11px] mb-2 ${item.auto_selected ? 'text-emerald-300' : 'text-slate-400'}">Auto Match: ${escHtml(item.matched_event.planned_title)} (${escHtml(item.matched_event.minutes_diff)} min diff)</div>` : '<div class="text-[11px] text-slate-500 mb-2">Auto Match: None within drift window</div>'}
                
                ${item.progress > 0 || item.file ? `
                    <div class="space-y-1">
                        <div class="flex justify-between text-xs font-mono text-slate-400 truncate">
                            <span class="truncate pr-4">${escHtml(item.file)}</span>
                            <span>${progressPct}%</span>
                        </div>
                        <div class="w-full bg-slate-950 rounded-full h-1.5 overflow-hidden">
                            <div class="bg-indigo-500 h-1.5 rounded-full transition-all duration-300" style="width: ${progressPct}%"></div>
                        </div>
                        ${transferEta ? `<div class="text-[10px] text-slate-500">ETA: ${escHtml(transferEta)}</div>` : ''}
                    </div>
                ` : `<div class="text-xs text-slate-500 italic">No storage IO operations running</div>`}

                ${(playbackScheduleState !== 'idle' && playbackScheduleState !== 'cancelled') ? `<div class="mt-2 text-[11px] text-slate-300">Playback Schedule: <span class="text-white">${escHtml(playbackScheduleState)}</span>${playbackScheduleAt ? ` at ${escHtml(playbackScheduleAt)}` : ''}</div>` : ''}

                <!-- Per-deck transport controls -->
                <div class="mt-4 flex items-center gap-2 border-t border-slate-800 pt-3">
                    <button onclick="sendDeckCommand(${jsIpAttr}, 'record')"
                        ${isRecording ? 'disabled' : ''}
                        class="flex-1 rounded px-2 py-1.5 text-xs font-semibold text-white transition cursor-pointer ${isRecording ? 'bg-red-900/50 text-red-300/50 cursor-not-allowed' : 'bg-red-600/90 hover:bg-red-500'}">
                        ⏺ ${isRecording ? 'Recording' : 'Record'}
                    </button>
                    <button onclick="playDeckNowFromCard(${jsIpAttr})"
                        class="flex-1 rounded bg-emerald-600/90 hover:bg-emerald-500 px-2 py-1.5 text-xs font-semibold text-white transition cursor-pointer">
                        ▶ Play
                    </button>
                    <button onclick="sendDeckCommand(${jsIpAttr}, 'stop')"
                        class="flex-1 rounded bg-slate-700 hover:bg-slate-600 px-2 py-1.5 text-xs font-semibold text-white transition cursor-pointer">
                        ⏹ Stop
                    </button>
                    <button type="button" onclick="openDeckRecordings(${jsIpAttr}, ${jsNameAttr})"
                        class="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1.5 text-xs text-slate-300 hover:text-white transition cursor-pointer" aria-label="Deck recordings">
                        📼
                    </button>
                    <button type="button" onclick="openDeckSettings(${jsIpAttr}, ${jsNameAttr})"
                        class="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1.5 text-xs text-slate-300 hover:text-white transition cursor-pointer" aria-label="Deck settings">
                        ⚙
                    </button>
                </div>
            </div>`;
        }
        container.innerHTML = html;

        const recordAllBtn = document.getElementById('btn-record-all');
        if (recordAllBtn) {
            if (allRecording && Object.keys(state).length > 0) {
                recordAllBtn.disabled = true;
                recordAllBtn.innerText = '⏺ All Recording';
                recordAllBtn.className = 'rounded-md bg-red-900/50 px-4 py-2 text-sm font-semibold text-red-300/50 cursor-not-allowed transition';
            } else {
                recordAllBtn.disabled = false;
                recordAllBtn.innerText = '⏺ Record All';
                recordAllBtn.className = 'rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-500 transition cursor-pointer';
            }
        }
    } catch (e) { console.error("Error updates tracking dropped out: ", e); }
}

async function pullConfigurationMatrix() {
    try {
        const res = await fetch('/api/config');
        if (!res.ok) return;
        localConfigCache = ensureConfigShape(await res.json());
        
        document.getElementById('cfg-template').value = localConfigCache.filename_template;
        document.getElementById('cfg-stage-mode').value = localConfigCache.stage_mode;
        document.getElementById('cfg-global-stage').value = localConfigCache.global_stage;
        document.getElementById('cfg-auto-mode').value = localConfigCache.schedule_auto_mode ? 'true' : 'false';
        document.getElementById('cfg-drift-minutes').value = localConfigCache.schedule_max_drift_minutes;
        renderSlateFieldInputs('cfg-slate-global-fields', 'cfg-global', localConfigCache.slate_metadata.global || {}, false);
        const slateStatus = document.getElementById('cfg-slate-status');
        if (slateStatus) slateStatus.innerText = 'Slate metadata is optional.';

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
        <input type="text" placeholder="/mnt/storage/ingest" value="${escHtml(path)}" class="dest-path block w-full rounded-md border-0 bg-slate-950 px-2 py-1 text-xs text-white ring-1 ring-inset ring-slate-800 focus:outline-none font-mono">
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
        <input type="text" placeholder="Device Label" value="${escHtml(name)}" class="d-name block w-1/3 rounded-md border-0 bg-slate-950 px-2 py-1 text-xs text-white ring-1 ring-inset ring-slate-800 focus:outline-none">
        <input type="text" placeholder="IP / Hostname" value="${escHtml(ip)}" class="d-ip block w-1/3 rounded-md border-0 bg-slate-950 px-2 py-1 text-xs text-white ring-1 ring-inset ring-slate-800 focus:outline-none">
        <input type="text" list="cfg-stage-options" placeholder="Stage" value="${escHtml(stage)}" class="d-stage block w-1/3 rounded-md border-0 bg-slate-950 px-2 py-1 text-xs text-white ring-1 ring-inset ring-slate-800 focus:outline-none">
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
    const slateStatus = document.getElementById('cfg-slate-status');

    const slateGlobalRoot = document.getElementById('cfg-slate-global-fields');
    const slateGlobal = buildSlateMetadataFromContainer(slateGlobalRoot, 'cfg-global');
    
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
        slate_metadata: {
            global: slateGlobal,
            per_deck: {},
            per_event: {},
        },
    };
    try {
        const res = await fetch('/api/config', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        if(res.ok) {
            alert('Configuration updated and reloaded cleanly!');
            if (slateStatus) slateStatus.innerText = 'Slate metadata saved.';
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
                        <span class="font-mono font-medium">${escHtml(ip)}</span>
                        ${alreadyAdded ? `<div class="text-[11px] text-emerald-300 mt-0.5">Already added as ${escHtml(existingDeckName)}</div>` : ''}
                    </div>
                    <button ${alreadyAdded ? 'disabled' : `onclick="addDeckToConfigRow('New_HyperDeck', '${escHtml(ip)}')"`} class="text-xs px-2 py-1 rounded border transition ${alreadyAdded ? 'bg-emerald-600/10 text-emerald-300 border-emerald-500/30 cursor-not-allowed' : 'bg-indigo-600/30 text-indigo-400 border-indigo-500/30 hover:bg-indigo-600 hover:text-white cursor-pointer'}">
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
                <button onclick="navigateFolder('${escHtml(nestedFullPath.replace(/\\/g, '\\\\'))}')" class="text-left w-full flex items-center gap-2 font-medium hover:text-white cursor-pointer truncate">
                    <span>📁</span> <span class="truncate">${escHtml(dirName)}</span>
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
                const schSlateMetadata = buildSlateMetadataFromContainer(el, 'sch');
                const schStart = schDate && schTime ? `${schDate} ${schTime}` : '';
                if (schId || schTitle || schStart) {
                    currentItems.push({ id: schId, planned_title: schTitle, start_time: schStart, stage: schStage, slate_metadata: schSlateMetadata });
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
    const slateMetadata = item.slate_metadata || {};
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
        <div class="mt-2">
            <label class="text-[10px] text-slate-400 space-y-1 block">
                <span class="block">Per-Event Slate Metadata ${hintBadge('Optional per-event metadata used when this event is matched during record.')}</span>
                <div class="grid grid-cols-2 gap-2">
                    ${SLATE_FIELD_CONFIG.map((field, idx) => {
                        const klass = slateFieldClassName('sch', field.key);
                        const current = escHtml(String(slateMetadata[field.key] || ''));
                        const hiddenClass = idx >= 4 ? 'sch-slate-extra hidden' : '';
                        if (field.type === 'select') {
                            const options = (field.options || []).map((option) => {
                                const selected = String(option) === String(slateMetadata[field.key] || '') ? 'selected' : '';
                                const label = option || '—';
                                return `<option value="${escHtml(option)}" ${selected}>${escHtml(label)}</option>`;
                            }).join('');
                            return `
                                <label class="${hiddenClass} text-[10px] text-slate-400 space-y-1">
                                    <span class="block">${escHtml(field.label)}</span>
                                    <select class="${klass} block w-full rounded bg-slate-950 border border-slate-800 text-[11px] px-2 py-1 text-slate-200 focus:outline-none">
                                        ${options}
                                    </select>
                                </label>
                            `;
                        }
                        const attrs = [
                            field.min ? `min="${field.min}"` : '',
                            field.max ? `max="${field.max}"` : '',
                            field.placeholder ? `placeholder="${escHtml(field.placeholder)}"` : '',
                        ].filter(Boolean).join(' ');
                        return `
                            <label class="${hiddenClass} text-[10px] text-slate-400 space-y-1">
                                <span class="block">${escHtml(field.label)}</span>
                                <input type="${field.type}" value="${current}" ${attrs} class="${klass} block w-full rounded border border-slate-800 bg-slate-950 text-[11px] px-2 py-1 text-slate-200 focus:outline-none">
                            </label>
                        `;
                    }).join('')}
                </div>
            </label>
            <div class="mt-1 flex justify-end gap-2">
                <button type="button" onclick="toggleEventSlateFields(this)" class="text-[10px] text-slate-400 hover:text-slate-200 font-medium cursor-pointer">Show all fields</button>
                <button type="button" onclick="insertEventSlateTemplate(this)" class="text-[10px] text-indigo-400 hover:text-indigo-300 font-medium cursor-pointer">Insert Slate Template</button>
            </div>
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
    const syncStatus = document.getElementById('plugin-sync-status');

    const normalizedRows = scheduleDataCache
        .map((row, idx) => {
            const plannedTitle = (row.planned_title || '').trim();
            const start_time = (row.start_time || '').trim();
            const stage = normalizeStageName(row.stage);
            const slate_metadata = (row.slate_metadata && typeof row.slate_metadata === 'object' && !Array.isArray(row.slate_metadata))
                ? row.slate_metadata
                : {};
            let id = (row.id || '').trim();
            const stableKey = (row._row_key || row._key || scheduleItemKey(row) || createTempRowKey()).toString();

            if (!id && start_time) {
                const safeTitle = (plannedTitle || `event_${idx + 1}`).replace(/\s+/g, '_').replace(/[^\w\-]/g, '').toLowerCase();
                id = `${start_time}_${safeTitle}`;
            }
            return { _row_key: stableKey, id, planned_title: plannedTitle, start_time, stage, slate_metadata };
        })
        .filter(row => row.id || row.planned_title || row.start_time);

    scheduleDataCache = normalizedRows;
    const payload = normalizedRows.map(({ id, planned_title, start_time, stage, slate_metadata }) => ({ id, planned_title, start_time, stage, slate_metadata }));

    await fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).then(res => { if (!res.ok) throw new Error('Failed to save schedule'); });

    renderScheduleMatrix(scheduleDataCache, true);

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
        slate_metadata: {},
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
    }).then(res => { if (!res.ok) throw new Error('Failed to clear schedule'); });
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
        let data;
        try { data = await res.json(); } catch (_) { data = {}; }
        if (!res.ok) {
            alert(`Command failed on ${host}: ${data.detail || 'Unknown error'}`);
        } else {
            console.info(`${label} on ${host}:`, data.response);
            updateDashboardMetrics();
        }
    } catch (e) {
        alert(`Could not reach backend API for ${host}.`);
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
        let data;
        try { data = await res.json(); } catch (_) { data = {}; }
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
let activeDeckRecordingsHost = '';
let deckRecordingsLastFocusedElement = null;
let pendingDeckFormatRequest = null;
let deckFormatProgressInterval = null;
let currentDeckClipMap = [];

function setDeckFormatControlsDisabled(disabled) {
    const ids = ['ds-format-slot', 'ds-format-filesystem', 'ds-format-name', 'btn-deck-format-card'];
    ids.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.disabled = !!disabled;
    });
}

function startDeckFormatProgress(statusEl) {
    if (!statusEl) return () => {};

    if (deckFormatProgressInterval) {
        clearInterval(deckFormatProgressInterval);
        deckFormatProgressInterval = null;
    }

    const startedAt = Date.now();
    const render = () => {
        const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
        statusEl.innerText = `Formatting card on deck... ${elapsed}s elapsed (this can take up to ~60s).`;
    };

    render();
    deckFormatProgressInterval = setInterval(render, 1000);

    return () => {
        if (deckFormatProgressInterval) {
            clearInterval(deckFormatProgressInterval);
            deckFormatProgressInterval = null;
        }
    };
}

function setDeckSettingSelectOptions(selectId, values = []) {
    const select = document.getElementById(selectId);
    if (!select) return;

    const normalized = [];
    const normalizedLower = new Set();
    values.forEach(value => {
        const clean = String(value || '').trim();
        const key = clean.toLowerCase();
        if (clean && !normalizedLower.has(key)) {
            normalized.push(clean);
            normalizedLower.add(key);
        }
    });

    select.innerHTML = '<option value="">— unchanged —</option>';
    normalized.forEach(value => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        select.appendChild(option);
    });
}

function applyDeckSettingOptions(options = {}) {
    const fieldMap = {
        'file format': 'ds-file-format',
        'video input': 'ds-video-input',
        'audio input': 'ds-audio-input',
        'audio codec': 'ds-audio-codec',
        'default standard': 'ds-default-standard',
        'audio input channels': 'ds-audio-input-channels',
        'timecode input': 'ds-timecode-input',
        'timecode output': 'ds-timecode-output',
        'audio meters': 'ds-audio-meters',
    };
    Object.entries(fieldMap).forEach(([key, selectId]) => {
        setDeckSettingSelectOptions(selectId, Array.isArray(options[key]) ? options[key] : []);
    });
}

function collectDeckSettingsValues() {
    const settings = {};
    const fieldMap = {
        'ds-file-format': 'file format',
        'ds-video-input': 'video input',
        'ds-audio-input': 'audio input',
        'ds-audio-codec': 'audio codec',
        'ds-default-standard': 'default standard',
        'ds-audio-input-channels': 'audio input channels',
        'ds-timecode-input': 'timecode input',
        'ds-timecode-output': 'timecode output',
        'ds-timecode-preset': 'timecode preset',
        'ds-audio-meters': 'audio meters',
        'ds-slate-reel': 'reel',
        'ds-scene-id': 'scene id',
        'ds-shot-type': 'shot type',
        'ds-take': 'take',
        'ds-take-scenario': 'take scenario',
        'ds-take-auto-inc': 'take auto inc',
        'ds-good-take': 'good take',
        'ds-environment': 'environment',
        'ds-day-night': 'day night',
        'ds-project-name': 'project name',
        'ds-camera': 'camera',
        'ds-director': 'director',
        'ds-camera-operator': 'camera operator',
    };

    Object.entries(fieldMap).forEach(([elId, key]) => {
        const el = document.getElementById(elId);
        if (!el) return;
        const value = String(el.value || '').trim();
        if (value) settings[key] = value;
    });
    return settings;
}

function renderDeckSettingsTargetHosts() {
    const hostListEl = document.getElementById('ds-target-hosts');
    if (!hostListEl) return;
    hostListEl.innerHTML = '';

    const decks = localConfigCache.hyperdecks || {};
    const entries = Object.entries(decks);
    if (entries.length === 0) {
        hostListEl.innerHTML = '<span class="text-slate-500 italic">No configured decks.</span>';
        return;
    }

    entries.forEach(([name, host]) => {
        const id = `ds-target-${String(host).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        const checked = String(host) === activeDeckSettingsHost ? 'checked' : '';
        const row = document.createElement('label');
        row.className = 'inline-flex items-center gap-2';
        row.innerHTML = `
            <input id="${id}" type="checkbox" class="ds-target-host-checkbox h-3.5 w-3.5 rounded border-slate-700 bg-slate-900" value="${escHtml(String(host))}" ${checked}>
            <span class="truncate">${escHtml(String(name))} <span class="text-slate-500">(${escHtml(String(host))})</span></span>
        `;
        hostListEl.appendChild(row);
    });
}

function selectedDeckSettingsTargetHosts() {
    return Array.from(document.querySelectorAll('.ds-target-host-checkbox:checked')).map((el) => String(el.value || '').trim()).filter(Boolean);
}

function renderDeckSettingsScopeToggles(selectedKeys = []) {
    const root = document.getElementById('ds-scope-fields');
    if (!root) return;

    const selected = new Set((selectedKeys.length ? selectedKeys : DECK_SETTINGS_SCOPE_OPTIONS.map((i) => i.key)).map((k) => String(k || '').trim().toLowerCase()));
    root.innerHTML = '';

    DECK_SETTINGS_SCOPE_OPTIONS.forEach((item) => {
        const checkboxId = `ds-scope-${item.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        const checked = selected.has(item.key.toLowerCase()) ? 'checked' : '';
        const row = document.createElement('label');
        row.className = 'inline-flex items-center gap-2';
        row.innerHTML = `
            <input id="${checkboxId}" type="checkbox" class="ds-scope-field-checkbox h-3.5 w-3.5 rounded border-slate-700 bg-slate-900" value="${escHtml(item.key)}" ${checked}>
            <span>${escHtml(item.label)}</span>
        `;
        root.appendChild(row);
    });
}

function selectedDeckSettingsScopeKeys() {
    return Array.from(document.querySelectorAll('.ds-scope-field-checkbox:checked')).map((el) => String(el.value || '').trim().toLowerCase()).filter(Boolean);
}

function setDeckSettingsScopeAll(selectAll) {
    document.querySelectorAll('.ds-scope-field-checkbox').forEach((el) => {
        el.checked = !!selectAll;
    });
}

function filterDeckSettingsByScope(settings) {
    const scopeKeys = new Set(selectedDeckSettingsScopeKeys());
    if (scopeKeys.size === 0) return {};
    const filtered = {};
    Object.entries(settings || {}).forEach(([key, value]) => {
        if (scopeKeys.has(String(key || '').trim().toLowerCase())) filtered[key] = value;
    });
    return filtered;
}

// --- Shared Settings Groups API helpers ---
async function _fetchSettingsGroups() {
    const res = await fetch('/api/control/settings-groups');
    if (!res.ok) return {};
    const data = await res.json();
    return (data && typeof data.groups === 'object' && data.groups) ? data.groups : {};
}

async function _saveSettingsGroup(name, targets, settings, field_keys) {
    const res = await fetch('/api/control/settings-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, targets, settings, field_keys }),
    });
    let data;
    try { data = await res.json(); } catch (_) { data = {}; }
    return { ok: res.ok, data };
}

async function _applySettingsGroup(name) {
    const res = await fetch(`/api/control/settings-groups/${encodeURIComponent(name)}/apply`, { method: 'POST' });
    let data;
    try { data = await res.json(); } catch (_) { data = {}; }
    return { ok: res.ok, data };
}

async function _deleteSettingsGroup(name) {
    const res = await fetch(`/api/control/settings-groups/${encodeURIComponent(name)}`, { method: 'DELETE' });
    let data;
    try { data = await res.json(); } catch (_) { data = {}; }
    return { ok: res.ok, data };
}

function renderDeckSettingsGroupOptions() {
    const groupSelect = document.getElementById('ds-group-select');
    if (!groupSelect) return;

    const current = groupSelect.value;
    groupSelect.innerHTML = '<option value="">Select group...</option>';
    Object.keys(deckSettingsGroupsCache).sort((a, b) => a.localeCompare(b)).forEach((name) => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        groupSelect.appendChild(option);
    });
    if (current && deckSettingsGroupsCache[current]) groupSelect.value = current;
}

async function loadDeckSettingsGroups() {
    try {
        deckSettingsGroupsCache = await _fetchSettingsGroups();
    } catch (_) {
        deckSettingsGroupsCache = {};
    }
    renderDeckSettingsGroupOptions();
}

function onDeckSettingsGroupSelected() {
    const groupSelect = document.getElementById('ds-group-select');
    const nameEl = document.getElementById('ds-group-name');
    const selectedName = String(groupSelect?.value || '').trim();
    if (!selectedName || !deckSettingsGroupsCache[selectedName]) return;

    const group = deckSettingsGroupsCache[selectedName] || {};
    const fieldKeys = Array.isArray(group.field_keys) ? group.field_keys : [];
    if (nameEl) nameEl.value = selectedName;
    renderDeckSettingsScopeToggles(fieldKeys);
}

async function applyDeckSettingsToSelectedTargets() {
    const statusEl = document.getElementById('deck-settings-status');
    const targets = selectedDeckSettingsTargetHosts();
    const settings = filterDeckSettingsByScope(collectDeckSettingsValues());

    if (targets.length === 0) {
        if (statusEl) statusEl.innerText = 'Select at least one target deck first.';
        return;
    }
    if (Object.keys(settings).length === 0) {
        if (statusEl) statusEl.innerText = 'No settings selected to apply.';
        return;
    }

    if (statusEl) statusEl.innerText = `Applying ${Object.keys(settings).length} setting(s) to ${targets.length} deck(s)...`;
    try {
        const res = await fetch('/api/control/apply-settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targets, settings }),
        });
        let data;
        try { data = await res.json(); } catch (_) { data = {}; }

        if (!res.ok) {
            if (statusEl) statusEl.innerText = `Apply failed: ${data.detail || 'Unknown error'}`;
            return;
        }

        const successCount = Number(data.success_count || 0);
        if (statusEl) statusEl.innerText = `Applied to ${successCount}/${targets.length} deck(s).`;
    } catch (_) {
        if (statusEl) statusEl.innerText = 'Apply failed: Could not reach backend API.';
    }
}

async function saveDeckSettingsGroup() {
    const statusEl = document.getElementById('deck-settings-status');
    const nameEl = document.getElementById('ds-group-name');
    const targets = selectedDeckSettingsTargetHosts();
    const settings = filterDeckSettingsByScope(collectDeckSettingsValues());
    const field_keys = selectedDeckSettingsScopeKeys();
    const name = String(nameEl?.value || '').trim();

    if (!name) {
        if (statusEl) statusEl.innerText = 'Enter a group name first.';
        return;
    }
    if (targets.length === 0) {
        if (statusEl) statusEl.innerText = 'Select at least one target deck for the group.';
        return;
    }
    if (Object.keys(settings).length === 0) {
        if (statusEl) statusEl.innerText = 'No settings selected to save in group.';
        return;
    }
    if (field_keys.length === 0) {
        if (statusEl) statusEl.innerText = 'Select at least one field in Field Scope.';
        return;
    }

    try {
        const { ok, data } = await _saveSettingsGroup(name, targets, settings, field_keys);

        if (!ok) {
            if (statusEl) statusEl.innerText = `Save group failed: ${data.detail || 'Unknown error'}`;
            return;
        }

        if (nameEl) nameEl.value = '';
        await loadDeckSettingsGroups();
        const selectEl = document.getElementById('ds-group-select');
        if (selectEl) selectEl.value = name;
        onDeckSettingsGroupSelected();
        if (statusEl) statusEl.innerText = `Saved settings group '${name}'.`;
    } catch (_) {
        if (statusEl) statusEl.innerText = 'Save group failed: Could not reach backend API.';
    }
}

async function applyDeckSettingsGroup() {
    const statusEl = document.getElementById('deck-settings-status');
    const selectEl = document.getElementById('ds-group-select');
    const name = String(selectEl?.value || '').trim();
    if (!name) {
        if (statusEl) statusEl.innerText = 'Select a group to apply.';
        return;
    }

    try {
        const { ok, data } = await _applySettingsGroup(name);
        if (!ok) {
            if (statusEl) statusEl.innerText = `Apply group failed: ${data.detail || 'Unknown error'}`;
            return;
        }
        const results = Array.isArray(data.results) ? data.results : [];
        const successCount = results.filter((r) => r && r.success).length;
        if (statusEl) statusEl.innerText = `Applied group '${name}' to ${successCount}/${results.length} deck(s).`;
    } catch (_) {
        if (statusEl) statusEl.innerText = 'Apply group failed: Could not reach backend API.';
    }
}

async function deleteDeckSettingsGroup() {
    const statusEl = document.getElementById('deck-settings-status');
    const selectEl = document.getElementById('ds-group-select');
    const name = String(selectEl?.value || '').trim();
    if (!name) {
        if (statusEl) statusEl.innerText = 'Select a group to delete.';
        return;
    }
    if (!window.confirm(`Delete settings group '${name}'?`)) return;

    try {
        const { ok, data } = await _deleteSettingsGroup(name);
        if (!ok) {
            if (statusEl) statusEl.innerText = `Delete group failed: ${data.detail || 'Unknown error'}`;
            return;
        }
        await loadDeckSettingsGroups();
        renderDeckSettingsScopeToggles();
        if (statusEl) statusEl.innerText = `Deleted group '${name}'.`;
    } catch (_) {
        if (statusEl) statusEl.innerText = 'Delete group failed: Could not reach backend API.';
    }
}

function renderSettingsGroupsTargetHosts(selectedHosts = []) {
    const hostListEl = document.getElementById('sg-target-hosts');
    if (!hostListEl) return;
    hostListEl.innerHTML = '';

    const selected = new Set((selectedHosts || []).map((h) => String(h || '').trim()));
    const decks = localConfigCache.hyperdecks || {};
    const entries = Object.entries(decks);
    if (entries.length === 0) {
        hostListEl.innerHTML = '<span class="text-slate-500 italic">No configured decks.</span>';
        return;
    }

    entries.forEach(([name, host]) => {
        const id = `sg-target-${String(host).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        const checked = selected.has(String(host)) ? 'checked' : '';
        const row = document.createElement('label');
        row.className = 'inline-flex items-center gap-2';
        row.innerHTML = `
            <input id="${id}" type="checkbox" class="sg-target-host-checkbox h-3.5 w-3.5 rounded border-slate-700 bg-slate-900" value="${escHtml(String(host))}" ${checked} onchange="onSettingsGroupsTargetSelectionChanged()">
            <span class="truncate">${escHtml(String(name))} <span class="text-slate-500">(${escHtml(String(host))})</span></span>
        `;
        hostListEl.appendChild(row);
    });
}

function selectedSettingsGroupsTargets() {
    return Array.from(document.querySelectorAll('.sg-target-host-checkbox:checked')).map((el) => String(el.value || '').trim()).filter(Boolean);
}

function setSettingsGroupsTargetsAll(selectAll) {
    document.querySelectorAll('.sg-target-host-checkbox').forEach((el) => {
        el.checked = !!selectAll;
    });
}

function renderSettingsGroupsScopeFields(selectedKeys = []) {
    const root = document.getElementById('sg-scope-fields');
    if (!root) return;
    const selected = new Set((selectedKeys.length ? selectedKeys : DECK_SETTINGS_SCOPE_OPTIONS.map((i) => i.key)).map((k) => String(k || '').trim().toLowerCase()));
    root.innerHTML = '';

    DECK_SETTINGS_SCOPE_OPTIONS.forEach((item) => {
        const checkboxId = `sg-scope-${item.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        const checked = selected.has(item.key.toLowerCase()) ? 'checked' : '';
        const row = document.createElement('label');
        row.className = 'inline-flex items-center gap-2';
        row.innerHTML = `
            <input id="${checkboxId}" type="checkbox" class="sg-scope-field-checkbox h-3.5 w-3.5 rounded border-slate-700 bg-slate-900" value="${escHtml(item.key)}" ${checked}>
            <span>${escHtml(item.label)}</span>
        `;
        root.appendChild(row);
    });
}

function selectedSettingsGroupsScopeKeys() {
    return Array.from(document.querySelectorAll('.sg-scope-field-checkbox:checked')).map((el) => String(el.value || '').trim().toLowerCase()).filter(Boolean);
}

function setSettingsGroupsScopeAll(selectAll) {
    document.querySelectorAll('.sg-scope-field-checkbox').forEach((el) => {
        el.checked = !!selectAll;
    });
}

function renderSettingsGroupsFieldEditor(settings = {}, optionSuggestions = {}, sourceLabel = '') {
    const container = document.getElementById('sg-settings-fields');
    if (!container) return;

    const fieldDefs = [
        { id: 'sg-file-format', key: 'file format', label: 'File Format', type: 'text', placeholder: 'H.264High' },
        { id: 'sg-video-input', key: 'video input', label: 'Video Input', type: 'text', placeholder: 'SDI' },
        { id: 'sg-audio-input', key: 'audio input', label: 'Audio Input', type: 'text', placeholder: 'embedded' },
        { id: 'sg-audio-codec', key: 'audio codec', label: 'Audio Codec', type: 'text', placeholder: 'AAC' },
        { id: 'sg-default-standard', key: 'default standard', label: 'Default Standard', type: 'text', placeholder: '1080p50' },
        { id: 'sg-audio-input-channels', key: 'audio input channels', label: 'Audio Channels', type: 'text', placeholder: '2' },
        { id: 'sg-timecode-input', key: 'timecode input', label: 'Timecode Input', type: 'text', placeholder: 'preset' },
        { id: 'sg-timecode-output', key: 'timecode output', label: 'Timecode Output', type: 'text', placeholder: 'embedded' },
        { id: 'sg-timecode-preset', key: 'timecode preset', label: 'Timecode Preset', type: 'text', placeholder: '00:00:00:00' },
        {
            id: 'sg-audio-meters',
            key: 'audio meters',
            label: 'Audio Meters',
            type: 'text',
            placeholder: 'VU (-18dBFS)',
            suggestions: ['VU (-18dBFS)', 'VU (-20dBFS)', 'PPM (-18dBFS)', 'PPM (-20dBFS)'],
        },
        { id: 'sg-reel', key: 'reel', label: 'Reel', type: 'text', placeholder: '1' },
        { id: 'sg-scene-id', key: 'scene id', label: 'Scene ID', type: 'text', placeholder: '12A' },
        { id: 'sg-shot-type', key: 'shot type', label: 'Shot Type', type: 'text', placeholder: 'WS' },
        { id: 'sg-take', key: 'take', label: 'Take', type: 'text', placeholder: '1' },
        { id: 'sg-take-scenario', key: 'take scenario', label: 'Take Scenario', type: 'text', placeholder: 'PU' },
        { id: 'sg-take-auto-inc', key: 'take auto inc', label: 'Take Auto Inc', type: 'text', placeholder: 'true' },
        { id: 'sg-good-take', key: 'good take', label: 'Good Take', type: 'text', placeholder: 'false' },
        { id: 'sg-environment', key: 'environment', label: 'Environment', type: 'text', placeholder: 'interior' },
        { id: 'sg-day-night', key: 'day night', label: 'Day/Night', type: 'text', placeholder: 'day' },
        { id: 'sg-project-name', key: 'project name', label: 'Project Name', type: 'text', placeholder: 'Production Name' },
        { id: 'sg-camera', key: 'camera', label: 'Camera', type: 'text', placeholder: 'A' },
        { id: 'sg-director', key: 'director', label: 'Director', type: 'text', placeholder: 'Director Name' },
        { id: 'sg-camera-operator', key: 'camera operator', label: 'Camera Operator', type: 'text', placeholder: 'Operator Name' },
    ];

    container.innerHTML = `
        ${sourceLabel ? `<div class="mb-2 text-[10px] text-slate-500">Suggestions from ${escHtml(sourceLabel)}</div>` : ''}
        <div class="grid grid-cols-2 gap-2">${fieldDefs.map((field) => {
        const dynamicSuggestions = Array.isArray(optionSuggestions[field.key]) ? optionSuggestions[field.key] : [];
        const mergedSuggestions = [...new Set([...(field.suggestions || []), ...dynamicSuggestions].map((value) => String(value || '').trim()).filter(Boolean))];
        const datalistId = mergedSuggestions.length ? `${field.id}-options` : '';
        const listAttr = datalistId ? ` list="${datalistId}"` : '';
        const datalistHtml = datalistId
            ? `<datalist id="${datalistId}">${mergedSuggestions.map((option) => `<option value="${escHtml(option)}"></option>`).join('')}</datalist>`
            : '';
        return `
        <label class="text-[10px] text-slate-400 space-y-1">
            <span class="block">${escHtml(field.label)}</span>
            <input id="${field.id}" type="${field.type}"${listAttr} value="${escHtml(String(settings[field.key] || ''))}" placeholder="${escHtml(field.placeholder)}" class="block w-full rounded border border-slate-800 bg-slate-900 text-[11px] px-2 py-1.5 text-slate-200 focus:outline-none">
            ${datalistHtml}
        </label>
    `;
    }).join('')}</div>`;
}

function collectSettingsGroupsFieldSettings() {
    const fieldMap = {
        'sg-file-format': 'file format',
        'sg-video-input': 'video input',
        'sg-audio-input': 'audio input',
        'sg-audio-codec': 'audio codec',
        'sg-default-standard': 'default standard',
        'sg-audio-input-channels': 'audio input channels',
        'sg-timecode-input': 'timecode input',
        'sg-timecode-output': 'timecode output',
        'sg-timecode-preset': 'timecode preset',
        'sg-audio-meters': 'audio meters',
        'sg-reel': 'reel',
        'sg-scene-id': 'scene id',
        'sg-shot-type': 'shot type',
        'sg-take': 'take',
        'sg-take-scenario': 'take scenario',
        'sg-take-auto-inc': 'take auto inc',
        'sg-good-take': 'good take',
        'sg-environment': 'environment',
        'sg-day-night': 'day night',
        'sg-project-name': 'project name',
        'sg-camera': 'camera',
        'sg-director': 'director',
        'sg-camera-operator': 'camera operator',
    };

    const settings = {};
    Object.entries(fieldMap).forEach(([id, key]) => {
        const el = document.getElementById(id);
        if (!el) return;
        const value = String(el.value || '').trim();
        if (value) settings[key] = value;
    });
    return settings;
}

function filterSettingsGroupsDraftByScope(settings) {
    const scope = new Set(selectedSettingsGroupsScopeKeys());
    if (scope.size === 0) return {};
    const filtered = {};
    Object.entries(settings || {}).forEach(([key, value]) => {
        if (scope.has(String(key || '').trim().toLowerCase())) filtered[key] = value;
    });
    return filtered;
}

function renderSettingsGroupsSelect() {
    const select = document.getElementById('sg-group-select');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">Select group...</option>';
    Object.keys(deckSettingsGroupsCache).sort((a, b) => a.localeCompare(b)).forEach((name) => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        select.appendChild(option);
    });
    if (current && deckSettingsGroupsCache[current]) select.value = current;
}

async function loadSettingsGroupsModalGroups() {
    try {
        deckSettingsGroupsCache = await _fetchSettingsGroups();
    } catch (_) {
        deckSettingsGroupsCache = {};
    }
    renderSettingsGroupsSelect();
}

function onSettingsGroupsGroupSelected() {
    const select = document.getElementById('sg-group-select');
    const name = String(select?.value || '').trim();
    const statusEl = document.getElementById('settings-groups-status');
    if (!name || !deckSettingsGroupsCache[name]) return;

    const group = deckSettingsGroupsCache[name] || {};
    const nameEl = document.getElementById('sg-group-name');
    if (nameEl) nameEl.value = name;
    renderSettingsGroupsFieldEditor(group.settings || {});

    renderSettingsGroupsTargetHosts(Array.isArray(group.targets) ? group.targets : []);
    renderSettingsGroupsScopeFields(Array.isArray(group.field_keys) ? group.field_keys : []);
    void refreshSettingsGroupsOptionSuggestions(group.settings || {});

    if (statusEl) statusEl.innerText = `Loaded group '${name}' with ${Array.isArray(group.targets) ? group.targets.length : 0} target(s).`;
}

async function openSettingsGroupsModal() {
    settingsGroupsLastFocusedElement = document.activeElement;
    const modal = document.getElementById('settings-groups-modal');
    const closeBtn = modal ? modal.querySelector('button[aria-label="Close settings groups"]') : null;
    const statusEl = document.getElementById('settings-groups-status');
    const nameEl = document.getElementById('sg-group-name');

    if (!modal) return;
    modal.classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
    if (closeBtn) closeBtn.focus();

    if (statusEl) statusEl.innerText = '';
    if (nameEl) nameEl.value = '';
    renderSettingsGroupsFieldEditor({});

    renderSettingsGroupsTargetHosts();
    renderSettingsGroupsScopeFields();
    await refreshSettingsGroupsOptionSuggestions({});
    await loadSettingsGroupsModalGroups();
}

function closeSettingsGroupsModal() {
    const modal = document.getElementById('settings-groups-modal');
    if (modal) modal.classList.add('hidden');
    document.body.classList.remove('overflow-hidden');
    if (settingsGroupsLastFocusedElement && typeof settingsGroupsLastFocusedElement.focus === 'function') {
        settingsGroupsLastFocusedElement.focus();
    }
    settingsGroupsLastFocusedElement = null;
}

function handleSettingsGroupsBackdropClick(event) {
    const modal = document.getElementById('settings-groups-modal');
    if (!modal) return;
    if (event.target === modal) closeSettingsGroupsModal();
}

async function saveSettingsGroupsGroup() {
    const statusEl = document.getElementById('settings-groups-status');
    const name = String(document.getElementById('sg-group-name')?.value || '').trim();
    const targets = selectedSettingsGroupsTargets();
    const scopeKeys = selectedSettingsGroupsScopeKeys();

    if (!name) {
        if (statusEl) statusEl.innerText = 'Enter a group name first.';
        return;
    }
    if (targets.length === 0) {
        if (statusEl) statusEl.innerText = 'Select at least one target deck.';
        return;
    }
    if (scopeKeys.length === 0) {
        if (statusEl) statusEl.innerText = 'Select at least one field in Field Scope.';
        return;
    }

    const settingsDraft = collectSettingsGroupsFieldSettings();
    const scopedSettings = filterSettingsGroupsDraftByScope(settingsDraft);
    if (Object.keys(scopedSettings).length === 0) {
        if (statusEl) statusEl.innerText = 'No settings remain after Field Scope filtering.';
        return;
    }

    try {
        const { ok, data } = await _saveSettingsGroup(name, targets, scopedSettings, scopeKeys);
        if (!ok) {
            if (statusEl) statusEl.innerText = `Save failed: ${data.detail || 'Unknown error'}`;
            return;
        }
        await loadSettingsGroupsModalGroups();
        const select = document.getElementById('sg-group-select');
        if (select) select.value = name;
        onSettingsGroupsGroupSelected();
        if (statusEl) statusEl.innerText = `Saved group '${name}'.`;
    } catch (_) {
        if (statusEl) statusEl.innerText = 'Save failed: Could not reach backend API.';
    }
}

async function applySettingsGroupsGroup() {
    const statusEl = document.getElementById('settings-groups-status');
    const name = String(document.getElementById('sg-group-select')?.value || '').trim();
    if (!name) {
        if (statusEl) statusEl.innerText = 'Select a group to apply.';
        return;
    }
    try {
        const { ok, data } = await _applySettingsGroup(name);
        if (!ok) {
            if (statusEl) statusEl.innerText = `Apply failed: ${data.detail || 'Unknown error'}`;
            return;
        }
        const results = Array.isArray(data.results) ? data.results : [];
        const successCount = results.filter((r) => r && r.success).length;
        if (statusEl) statusEl.innerText = `Applied '${name}' to ${successCount}/${results.length} deck(s).`;
    } catch (_) {
        if (statusEl) statusEl.innerText = 'Apply failed: Could not reach backend API.';
    }
}

async function deleteSettingsGroupsGroup() {
    const statusEl = document.getElementById('settings-groups-status');
    const select = document.getElementById('sg-group-select');
    const name = String(select?.value || '').trim();
    if (!name) {
        if (statusEl) statusEl.innerText = 'Select a group to delete.';
        return;
    }
    if (!window.confirm(`Delete settings group '${name}'?`)) return;

    try {
        const { ok, data } = await _deleteSettingsGroup(name);
        if (!ok) {
            if (statusEl) statusEl.innerText = `Delete failed: ${data.detail || 'Unknown error'}`;
            return;
        }
        await loadSettingsGroupsModalGroups();
        renderSettingsGroupsTargetHosts();
        renderSettingsGroupsScopeFields();
        const nameEl = document.getElementById('sg-group-name');
        if (nameEl) nameEl.value = '';
        renderSettingsGroupsFieldEditor({});
        if (statusEl) statusEl.innerText = `Deleted group '${name}'.`;
    } catch (_) {
        if (statusEl) statusEl.innerText = 'Delete failed: Could not reach backend API.';
    }
}

async function applySettingsGroupsDraftToSelected() {
    const statusEl = document.getElementById('settings-groups-status');
    const targets = selectedSettingsGroupsTargets();
    if (targets.length === 0) {
        if (statusEl) statusEl.innerText = 'Select at least one target deck.';
        return;
    }

    const settingsDraft = collectSettingsGroupsFieldSettings();
    const scopedSettings = filterSettingsGroupsDraftByScope(settingsDraft);
    if (Object.keys(scopedSettings).length === 0) {
        if (statusEl) statusEl.innerText = 'No settings remain after Field Scope filtering.';
        return;
    }

    try {
        const res = await fetch('/api/control/apply-settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targets, settings: scopedSettings }),
        });
        let data;
        try { data = await res.json(); } catch (_) { data = {}; }
        if (!res.ok) {
            if (statusEl) statusEl.innerText = `Apply failed: ${data.detail || 'Unknown error'}`;
            return;
        }
        const successCount = Number(data.success_count || 0);
        if (statusEl) statusEl.innerText = `Applied draft settings to ${successCount}/${targets.length} deck(s).`;
    } catch (_) {
        if (statusEl) statusEl.innerText = 'Apply failed: Could not reach backend API.';
    }
}

function setDeckSettingsInputValue(inputId, value) {
    const el = document.getElementById(inputId);
    if (!el) return;
    el.value = (value ?? '').toString();
}

async function loadDeckFormatSlotOptions(host) {
    const slotSelect = document.getElementById('ds-format-slot');
    if (!slotSelect) return;

    const previous = slotSelect.value || '1';
    slotSelect.innerHTML = '';
    try {
        const res = await fetch(`/api/control/${encodeURIComponent(host)}/slots`);
        let data;
        try { data = await res.json(); } catch (_) { data = {}; }
        const slots = Array.isArray(data.slots) && data.slots.length > 0 ? data.slots : ['1'];
        slots.forEach((slot) => {
            const option = document.createElement('option');
            option.value = String(slot);
            option.textContent = String(slot);
            slotSelect.appendChild(option);
        });
        slotSelect.value = slots.includes(previous) ? previous : String(slots[0]);
    } catch (_) {
        ['1', '2'].forEach((slot) => {
            const option = document.createElement('option');
            option.value = slot;
            option.textContent = slot;
            slotSelect.appendChild(option);
        });
        slotSelect.value = previous || '1';
    }
}

function formatDeckCard() {
    if (!activeDeckSettingsHost) return;
    const slotEl = document.getElementById('ds-format-slot');
    const fsEl = document.getElementById('ds-format-filesystem');
    const nameEl = document.getElementById('ds-format-name');
    const statusEl = document.getElementById('deck-format-status');
    if (!slotEl || !fsEl || !statusEl) return;

    const slotId = (slotEl.value || '1').trim() || '1';
    const filesystem = (fsEl.value || 'exFAT').trim() || 'exFAT';
    const volumeName = (nameEl?.value || '').trim();

    pendingDeckFormatRequest = {
        host: activeDeckSettingsHost,
        slotId,
        filesystem,
        volumeName,
    };

    const summaryEl = document.getElementById('deck-format-confirm-summary');
    if (summaryEl) {
        const namePart = volumeName ? `, volume name '${volumeName}'` : '';
        summaryEl.innerText = `Format slot ${slotId} as ${filesystem}${namePart}.`;
    }

    const checkbox = document.getElementById('deck-format-confirm-checkbox');
    const confirmBtn = document.getElementById('btn-confirm-deck-format');
    if (checkbox) checkbox.checked = false;
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.classList.add('cursor-not-allowed');
        confirmBtn.classList.remove('cursor-pointer', 'hover:bg-rose-600', 'hover:text-white');
    }

    if (checkbox && !checkbox.dataset.bound) {
        checkbox.addEventListener('change', () => {
            const btn = document.getElementById('btn-confirm-deck-format');
            if (!btn) return;
            btn.disabled = !checkbox.checked;
            if (checkbox.checked) {
                btn.classList.remove('cursor-not-allowed');
                btn.classList.add('cursor-pointer', 'hover:bg-rose-600', 'hover:text-white');
            } else {
                btn.classList.add('cursor-not-allowed');
                btn.classList.remove('cursor-pointer', 'hover:bg-rose-600', 'hover:text-white');
            }
        });
        checkbox.dataset.bound = 'true';
    }

    const modal = document.getElementById('deck-format-confirm-modal');
    modal?.classList.remove('hidden');
}

function closeDeckFormatConfirmDialog() {
    const modal = document.getElementById('deck-format-confirm-modal');
    if (modal) modal.classList.add('hidden');
}

function handleDeckFormatConfirmBackdropClick(event) {
    const modal = document.getElementById('deck-format-confirm-modal');
    if (!modal) return;
    if (event.target === modal) closeDeckFormatConfirmDialog();
}

async function confirmDeckFormatAction() {
    if (!pendingDeckFormatRequest) return;

    const statusEl = document.getElementById('deck-format-status');
    const btn = document.getElementById('btn-deck-format-card');
    const confirmBtn = document.getElementById('btn-confirm-deck-format');
    const { host, slotId, filesystem, volumeName } = pendingDeckFormatRequest;

    closeDeckFormatConfirmDialog();

    const stopProgress = startDeckFormatProgress(statusEl);
    setDeckFormatControlsDisabled(true);
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Formatting…';
    }
    if (confirmBtn) confirmBtn.disabled = true;

    pendingDeckFormatRequest = null;

    try {
        const res = await fetch(`/api/control/${encodeURIComponent(host)}/format-card`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                slot_id: slotId,
                filesystem,
                volume_name: volumeName,
                confirm_text: 'FORMAT',
            }),
        });

        let data;
        try { data = await res.json(); } catch (_) { data = {}; }

        if (!res.ok) {
            const detail = typeof data.detail === 'string'
                ? data.detail
                : (data.detail?.message || 'Unknown error');
            let suffix = '';
            if (data.detail && typeof data.detail === 'object') {
                if (Array.isArray(data.detail.attempts) && data.detail.attempts.length > 0) {
                    const first = data.detail.attempts[0] || {};
                    suffix = ` First response: ${String(first.response || '').slice(0, 120)}`;
                }
            }
            if (statusEl) statusEl.innerText = `Format failed: ${detail}${suffix}`;
            return;
        }

        if (statusEl) {
            const confirmResponse = String(data.response || '').trim();
            const responseSuffix = confirmResponse ? ` Response: ${confirmResponse}` : '';
            statusEl.innerText = `Format completed for slot ${slotId} (${filesystem}).${responseSuffix}`;
        }
    } catch (_) {
        if (statusEl) statusEl.innerText = 'Format failed: Could not reach backend API.';
    } finally {
        stopProgress();
        setDeckFormatControlsDisabled(false);
        if (btn) {
            btn.disabled = false;
            btn.innerText = 'Format Card';
        }
        if (confirmBtn) confirmBtn.disabled = false;
    }
}

function formatBytes(bytes) {
    const size = Number(bytes || 0);
    if (!Number.isFinite(size) || size <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let idx = 0;
    let value = size;
    while (value >= 1024 && idx < units.length - 1) {
        value /= 1024;
        idx += 1;
    }
    return `${value.toFixed(value >= 100 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function formatDeckModified(value) {
    const raw = String(value || '').trim();
    if (!raw || !/^\d{14}$/.test(raw)) return raw;
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} ${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}`;
}

function formatEtaSeconds(value) {
    const seconds = Number.parseInt(value, 10);
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const rem = seconds % 60;
    return `${minutes}m ${rem}s`;
}

async function loadDeckRecordingsList() {
    if (!activeDeckRecordingsHost) return;
    const listEl = document.getElementById('deck-recordings-list');
    const statusEl = document.getElementById('deck-recordings-status');
    const slotEl = document.getElementById('drm-slot');
    const loadBtn = document.getElementById('btn-drm-refresh');
    if (!listEl || !statusEl || !slotEl || !loadBtn) return;

    const slotId = (slotEl.value || '1').trim() || '1';
    loadBtn.disabled = true;
    loadBtn.innerText = 'Loading…';
    listEl.innerHTML = '<div class="text-[11px] text-slate-500 px-2 py-2">Loading recordings…</div>';
    statusEl.innerText = '';

    try {
        const res = await fetch(`/api/control/${encodeURIComponent(activeDeckRecordingsHost)}/recordings?slot_id=${encodeURIComponent(slotId)}`);
        let data;
        try { data = await res.json(); } catch (_) { data = {}; }

        if (!res.ok) {
            statusEl.innerText = `Could not load recordings: ${data.detail || 'Unknown error'}`;
            listEl.innerHTML = '<div class="text-[11px] text-rose-400 px-2 py-2">Failed to load recordings.</div>';
            return;
        }

        const recordings = Array.isArray(data.recordings) ? data.recordings : [];
        if (recordings.length === 0) {
            listEl.innerHTML = '<div class="text-[11px] text-slate-500 px-2 py-2">No recordings found in this slot.</div>';
            statusEl.innerText = 'No transferable recordings found.';
            return;
        }

        listEl.innerHTML = '';
        recordings.forEach((item) => {
            const row = document.createElement('div');
            row.className = 'grid grid-cols-12 gap-2 items-center px-2 py-2 border-b border-slate-800 last:border-b-0 text-[11px]';

            const name = String(item.name || '');
            const size = formatBytes(item.size || 0);
            const modified = formatDeckModified(item.modified || '');

            const nameEl = document.createElement('div');
            nameEl.className = 'col-span-6 text-slate-200 truncate';
            nameEl.title = name;
            nameEl.textContent = name;

            const metaEl = document.createElement('div');
            metaEl.className = 'col-span-4 text-slate-500 truncate';
            metaEl.title = modified ? `${size} · ${modified}` : size;
            metaEl.textContent = modified ? `${size} · ${modified}` : size;

            const btnWrap = document.createElement('div');
            btnWrap.className = 'col-span-2 flex justify-end';

            const clipId = findDeckClipIdByName(name);

            const pickBtn = document.createElement('button');
            pickBtn.type = 'button';
            pickBtn.className = 'text-[10px] bg-slate-800 text-slate-300 border border-slate-700 rounded px-2 py-1 hover:bg-slate-700 hover:text-white transition cursor-pointer mr-1';
            pickBtn.textContent = 'Use';
            pickBtn.addEventListener('click', () => selectClipForPlayback(name, clipId));

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'text-[10px] bg-indigo-600/20 text-indigo-300 border border-indigo-500/30 rounded px-2 py-1 hover:bg-indigo-600 hover:text-white transition cursor-pointer';
            btn.textContent = 'Transfer';
            btn.addEventListener('click', () => transferDeckRecording(name));
            btnWrap.appendChild(pickBtn);
            btnWrap.appendChild(btn);

            row.appendChild(nameEl);
            row.appendChild(metaEl);
            row.appendChild(btnWrap);
            listEl.appendChild(row);
        });

        statusEl.innerText = `${recordings.length} recording(s) available in slot ${slotId}.`;
    } catch (_) {
        listEl.innerHTML = '<div class="text-[11px] text-rose-400 px-2 py-2">Could not reach backend API.</div>';
        statusEl.innerText = 'Failed to load recordings.';
    } finally {
        loadBtn.disabled = false;
        loadBtn.innerText = 'Refresh';
    }
}

async function transferDeckRecording(remoteFilename) {
    if (!activeDeckRecordingsHost) return;
    const statusEl = document.getElementById('deck-recordings-status');
    const slotEl = document.getElementById('drm-slot');
    const slotId = (slotEl?.value || '1').trim() || '1';

    let resolvedLocalFilename = remoteFilename;
    try {
        const previewRes = await fetch(`/api/control/${encodeURIComponent(activeDeckRecordingsHost)}/transfer-preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slot_id: slotId, remote_filename: remoteFilename }),
        });
        if (previewRes.ok) {
            const previewData = await previewRes.json();
            resolvedLocalFilename = String(previewData.resolved_local_filename || remoteFilename);
        }
    } catch (_) {
        // Non-fatal: transfer endpoint will still resolve safely server-side.
    }

    if (statusEl) statusEl.innerText = `Transferring ${remoteFilename} as ${resolvedLocalFilename}...`;
    try {
        const res = await fetch(`/api/control/${encodeURIComponent(activeDeckRecordingsHost)}/transfer-recording`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slot_id: slotId, remote_filename: remoteFilename, local_filename: resolvedLocalFilename }),
        });
        let data;
        try { data = await res.json(); } catch (_) { data = {}; }

        if (!res.ok) {
            if (statusEl) statusEl.innerText = `Transfer failed: ${data.detail || 'Unknown error'}`;
            return;
        }

        if (statusEl) statusEl.innerText = `Transfer started/completed: ${data.local_filename || remoteFilename}`;
        updateDashboardMetrics();
    } catch (_) {
        if (statusEl) statusEl.innerText = 'Transfer failed: Could not reach backend API.';
    }
}

function findDeckClipIdByName(filename) {
    const target = String(filename || '').trim().toLowerCase();
    if (!target) return '';
    const match = currentDeckClipMap.find((clip) => String(clip.name || '').trim().toLowerCase() === target);
    return match ? String(match.id || '') : '';
}

function onDeckClipSelectionChanged() {
    const selectEl = document.getElementById('drm-clip-select');
    const clipIdEl = document.getElementById('drm-clip-id');
    if (!selectEl || !clipIdEl) return;
    clipIdEl.value = String(selectEl.value || '').trim();
}

function selectClipForPlayback(filename, clipId = '') {
    const resolvedClipId = String(clipId || findDeckClipIdByName(filename) || '').trim();
    const clipIdEl = document.getElementById('drm-clip-id');
    const clipSelectEl = document.getElementById('drm-clip-select');
    const statusEl = document.getElementById('drm-playback-status');

    if (clipIdEl) clipIdEl.value = resolvedClipId;
    if (clipSelectEl && resolvedClipId) clipSelectEl.value = resolvedClipId;

    if (statusEl) {
        if (resolvedClipId) statusEl.innerText = `Selected clip ${resolvedClipId} (${filename}).`;
        else statusEl.innerText = `Could not map ${filename} to a clip id. Enter clip id manually.`;
    }
}

async function loadDeckClipOptions() {
    if (!activeDeckRecordingsHost) return;
    const slotEl = document.getElementById('drm-slot');
    const clipSelectEl = document.getElementById('drm-clip-select');
    const playbackStatusEl = document.getElementById('drm-playback-status');
    const clipIdEl = document.getElementById('drm-clip-id');
    if (!clipSelectEl) return;

    const slotId = (slotEl?.value || '1').trim() || '1';
    const previous = String(clipSelectEl.value || clipIdEl?.value || '').trim();

    clipSelectEl.innerHTML = '<option value="">Select a clip from list...</option>';
    currentDeckClipMap = [];

    try {
        const res = await fetch(`/api/control/${encodeURIComponent(activeDeckRecordingsHost)}/clips?slot_id=${encodeURIComponent(slotId)}`);
        let data;
        try { data = await res.json(); } catch (_) { data = {}; }

        if (!res.ok) {
            if (playbackStatusEl) playbackStatusEl.innerText = `Could not load clips: ${data.detail || 'Unknown error'}`;
            return;
        }

        const clips = Array.isArray(data.clips) ? data.clips : [];
        currentDeckClipMap = clips.map((clip) => ({
            id: String(clip.id || ''),
            name: String(clip.name || ''),
            label: String(clip.label || clip.name || clip.id || ''),
        })).filter((clip) => clip.id);

        currentDeckClipMap.forEach((clip) => {
            const option = document.createElement('option');
            option.value = clip.id;
            option.textContent = `${clip.id}: ${clip.label || clip.name || `clip ${clip.id}`}`;
            clipSelectEl.appendChild(option);
        });

        if (previous && currentDeckClipMap.some((clip) => clip.id === previous)) {
            clipSelectEl.value = previous;
        }

        if (playbackStatusEl) {
            const source = String(data.source || 'hyperdeck');
            playbackStatusEl.innerText = `${currentDeckClipMap.length} clip(s) loaded (${source}).`;
        }
    } catch (_) {
        if (playbackStatusEl) playbackStatusEl.innerText = 'Could not reach backend API for clip list.';
    }
}

async function uploadDeckPlaybackFile() {
    if (!activeDeckRecordingsHost) return;
    const fileInput = document.getElementById('drm-upload-file');
    const statusEl = document.getElementById('drm-upload-status');
    const progressWrap = document.getElementById('drm-upload-progress-wrap');
    const progressBar = document.getElementById('drm-upload-progress-bar');
    const progressText = document.getElementById('drm-upload-progress-text');
    const slotEl = document.getElementById('drm-slot');
    const btn = document.getElementById('btn-drm-upload');
    const file = fileInput?.files && fileInput.files[0];
    if (!file) {
        if (statusEl) statusEl.innerText = 'Select a media file first.';
        return;
    }

    const slotId = (slotEl?.value || '1').trim() || '1';
    const form = new FormData();
    form.append('file', file);

    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Uploading…';
    }
    if (progressWrap) progressWrap.classList.remove('hidden');
    if (progressBar) progressBar.style.width = '0%';
    if (progressText) progressText.innerText = '0%';
    if (statusEl) statusEl.innerText = `Uploading ${file.name} to slot ${slotId}...`;

    try {
        const data = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `/api/control/${encodeURIComponent(activeDeckRecordingsHost)}/upload-playback?slot_id=${encodeURIComponent(slotId)}`);

            xhr.upload.onprogress = (event) => {
                if (!event.lengthComputable) return;
                const pct = Math.max(0, Math.min(100, Math.round((event.loaded / Math.max(event.total, 1)) * 100)));
                if (progressBar) progressBar.style.width = `${pct}%`;
                if (progressText) progressText.innerText = `${pct}%`;
            };

            xhr.onerror = () => reject(new Error('network'));
            xhr.onload = () => {
                let parsed = {};
                try {
                    parsed = xhr.responseText ? JSON.parse(xhr.responseText) : {};
                } catch (_) {
                    parsed = {};
                }
                if (xhr.status < 200 || xhr.status >= 300) {
                    reject(new Error(parsed.detail || 'Unknown error'));
                    return;
                }
                resolve(parsed);
            };

            xhr.send(form);
        });

        if (progressBar) progressBar.style.width = '100%';
        if (progressText) progressText.innerText = '100%';
        if (statusEl) statusEl.innerText = `Uploaded ${data.filename || file.name} (${formatBytes(data.size || file.size)}).`;
        await loadDeckRecordingsList();
    } catch (err) {
        const message = (err && err.message) ? err.message : 'Could not reach backend API.';
        if (statusEl) statusEl.innerText = `Upload failed: ${message}`;
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = 'Upload';
        }
    }
}

async function cueDeckPlayback() {
    if (!activeDeckRecordingsHost) return;
    const clipEl = document.getElementById('drm-clip-id');
    const statusEl = document.getElementById('drm-playback-status');
    const clipId = String(clipEl?.value || '').trim();
    if (!clipId) {
        if (statusEl) statusEl.innerText = 'Clip ID is required to cue playback.';
        return;
    }

    try {
        const res = await fetch(`/api/control/${encodeURIComponent(activeDeckRecordingsHost)}/cue`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clip_id: clipId }),
        });
        let data;
        try { data = await res.json(); } catch (_) { data = {}; }
        if (!res.ok) {
            if (statusEl) statusEl.innerText = `Cue failed: ${data.detail || 'Unknown error'}`;
            return;
        }
        if (statusEl) statusEl.innerText = `Cued clip ${clipId}.`;
        updateDashboardMetrics();
    } catch (_) {
        if (statusEl) statusEl.innerText = 'Cue failed: Could not reach backend API.';
    }
}

async function playDeckNow() {
    if (!activeDeckRecordingsHost) return;
    const statusEl = document.getElementById('drm-playback-status');
    const clipIdEl = document.getElementById('drm-clip-id');
    const clipId = String(clipIdEl?.value || '').trim();
    try {
        const body = clipId ? JSON.stringify({ clip_id: clipId }) : undefined;
        const res = await fetch(`/api/control/${encodeURIComponent(activeDeckRecordingsHost)}/play`, {
            method: 'POST',
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body,
        });
        let data;
        try { data = await res.json(); } catch (_) { data = {}; }
        if (!res.ok) {
            if (statusEl) statusEl.innerText = `Play failed: ${data.detail || 'Unknown error'}`;
            return;
        }
        if (statusEl) statusEl.innerText = 'Playback started.';
        updateDashboardMetrics();
    } catch (_) {
        if (statusEl) statusEl.innerText = 'Play failed: Could not reach backend API.';
    }
}

async function playDeckNowFromCard(host) {
    try {
        const res = await fetch(`/api/control/${encodeURIComponent(host)}/play`, { method: 'POST' });
        let data;
        try { data = await res.json(); } catch (_) { data = {}; }
        if (!res.ok) {
            alert(`Play failed on ${host}: ${data.detail || 'Unknown error'}`);
            return;
        }
        updateDashboardMetrics();
    } catch (_) {
        alert(`Play failed on ${host}: Could not reach backend API.`);
    }
}

async function scheduleDeckPlayback() {
    if (!activeDeckRecordingsHost) return;
    const clipEl = document.getElementById('drm-clip-id');
    const playAtEl = document.getElementById('drm-play-at');
    const statusEl = document.getElementById('drm-playback-status');

    const playAtLocal = String(playAtEl?.value || '').trim();
    if (!playAtLocal) {
        if (statusEl) statusEl.innerText = 'Choose a Play At time first.';
        return;
    }
    const playAtIso = new Date(playAtLocal).toISOString();
    const clipId = String(clipEl?.value || '').trim();

    try {
        const res = await fetch(`/api/control/${encodeURIComponent(activeDeckRecordingsHost)}/play-schedule`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ play_at: playAtIso, clip_id: clipId }),
        });
        let data;
        try { data = await res.json(); } catch (_) { data = {}; }
        if (!res.ok) {
            if (statusEl) statusEl.innerText = `Schedule failed: ${data.detail || 'Unknown error'}`;
            return;
        }
        if (statusEl) statusEl.innerText = `Scheduled playback at ${new Date(playAtIso).toLocaleString()}.`;
        updateDashboardMetrics();
    } catch (_) {
        if (statusEl) statusEl.innerText = 'Schedule failed: Could not reach backend API.';
    }
}

async function cancelDeckPlaybackSchedule() {
    if (!activeDeckRecordingsHost) return;
    const statusEl = document.getElementById('drm-playback-status');
    try {
        const res = await fetch(`/api/control/${encodeURIComponent(activeDeckRecordingsHost)}/play-schedule`, { method: 'DELETE' });
        let data;
        try { data = await res.json(); } catch (_) { data = {}; }
        if (!res.ok) {
            if (statusEl) statusEl.innerText = `Cancel failed: ${data.detail || 'Unknown error'}`;
            return;
        }
        if (statusEl) statusEl.innerText = 'Scheduled playback cancelled.';
        updateDashboardMetrics();
    } catch (_) {
        if (statusEl) statusEl.innerText = 'Cancel failed: Could not reach backend API.';
    }
}

async function loadDeckSlotOptions() {
    if (!activeDeckRecordingsHost) return;
    const slotSelect = document.getElementById('drm-slot');
    const statusEl = document.getElementById('deck-recordings-status');
    if (!slotSelect) return;

    const previous = slotSelect.value || '1';
    slotSelect.innerHTML = '';
    try {
        const res = await fetch(`/api/control/${encodeURIComponent(activeDeckRecordingsHost)}/slots`);
        let data;
        try { data = await res.json(); } catch (_) { data = {}; }
        const slots = Array.isArray(data.slots) && data.slots.length > 0 ? data.slots : ['1'];
        slots.forEach((slot) => {
            const option = document.createElement('option');
            option.value = String(slot);
            option.textContent = String(slot);
            slotSelect.appendChild(option);
        });
        slotSelect.value = slots.includes(previous) ? previous : String(slots[0]);
    } catch (_) {
        ['1', '2'].forEach((slot) => {
            const option = document.createElement('option');
            option.value = slot;
            option.textContent = slot;
            slotSelect.appendChild(option);
        });
        slotSelect.value = previous || '1';
        if (statusEl) statusEl.innerText = 'Could not query slot list from deck. Using fallback slots.';
    }
}

async function openDeckRecordings(host, name) {
    activeDeckRecordingsHost = host;
    deckRecordingsLastFocusedElement = document.activeElement;

    const modal = document.getElementById('deck-recordings-modal');
    const hostLabel = document.getElementById('deck-recordings-host');
    const listEl = document.getElementById('deck-recordings-list');
    const statusEl = document.getElementById('deck-recordings-status');
    const uploadStatusEl = document.getElementById('drm-upload-status');
    const playbackStatusEl = document.getElementById('drm-playback-status');
    const clipSelectEl = document.getElementById('drm-clip-select');
    const clipIdEl = document.getElementById('drm-clip-id');
    const closeBtn = modal ? modal.querySelector('button[aria-label="Close deck recordings"]') : null;
    if (!modal || !hostLabel || !listEl || !statusEl) return;

    hostLabel.innerText = `${name} — ${host}`;
    listEl.innerHTML = '<div class="text-[11px] text-slate-500 px-2 py-2">Loading recordings…</div>';
    statusEl.innerText = '';
    if (uploadStatusEl) uploadStatusEl.innerText = '';
    if (playbackStatusEl) playbackStatusEl.innerText = '';
    if (clipSelectEl) clipSelectEl.innerHTML = '<option value="">Select a clip from list...</option>';
    if (clipIdEl) clipIdEl.value = '';
    currentDeckClipMap = [];

    modal.classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
    if (closeBtn) closeBtn.focus();

    await loadDeckSlotOptions();
    await loadDeckClipOptions();
    await loadDeckRecordingsList();
}

function closeDeckRecordings() {
    const modal = document.getElementById('deck-recordings-modal');
    if (modal) modal.classList.add('hidden');
    document.body.classList.remove('overflow-hidden');
    activeDeckRecordingsHost = '';
    if (deckRecordingsLastFocusedElement && typeof deckRecordingsLastFocusedElement.focus === 'function') {
        deckRecordingsLastFocusedElement.focus();
    }
    deckRecordingsLastFocusedElement = null;
}

function isDeckRecordingsOpen() {
    const modal = document.getElementById('deck-recordings-modal');
    return !!modal && !modal.classList.contains('hidden');
}

function handleDeckRecordingsBackdropClick(event) {
    const modal = document.getElementById('deck-recordings-modal');
    if (!modal) return;
    if (event.target === modal) closeDeckRecordings();
}

async function openDeckSettings(host, name) {
    activeDeckSettingsHost = host;
    deckSettingsLastFocusedElement = document.activeElement;
    const modal = document.getElementById('deck-settings-modal');
    const closeBtn = modal ? modal.querySelector('button[aria-label="Close deck settings"]') : null;
    const hostLabel = document.getElementById('deck-settings-host');
    const loadingEl = document.getElementById('deck-settings-loading');
    const formEl = document.getElementById('deck-settings-form');
    const errorEl = document.getElementById('deck-settings-error');
    const saveBtn = document.getElementById('btn-save-deck-settings');
    const statusEl = document.getElementById('deck-settings-status');
    const sourceEl = document.getElementById('deck-settings-options-source');
    const debugEl = document.getElementById('deck-settings-debug');
    const debugBtn = document.getElementById('btn-deck-settings-debug');

    hostLabel.innerText = `${name} — ${host}`;
    loadingEl.classList.remove('hidden');
    formEl.classList.add('hidden');
    errorEl.classList.add('hidden');
    saveBtn.classList.add('hidden');
    if (statusEl) statusEl.innerText = '';
    if (sourceEl) sourceEl.innerText = 'Options source: —';
    if (debugEl) debugEl.innerText = 'No diagnostics loaded.';
    if (debugBtn) {
        debugBtn.disabled = false;
        debugBtn.innerText = 'Load Debug';
    }
    const formatStatusEl = document.getElementById('deck-format-status');
    if (formatStatusEl) formatStatusEl.innerText = '';
    const formatNameEl = document.getElementById('ds-format-name');
    if (formatNameEl) formatNameEl.value = '';
    modal.classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
    if (closeBtn) closeBtn.focus();

    // Reset selects to "unchanged"
    [
        'ds-file-format',
        'ds-video-input',
        'ds-audio-input',
        'ds-audio-codec',
        'ds-default-standard',
        'ds-audio-input-channels',
        'ds-timecode-input',
        'ds-timecode-output',
        'ds-timecode-preset',
        'ds-audio-meters',
        'ds-slate-reel',
        'ds-scene-id',
        'ds-shot-type',
        'ds-take',
        'ds-take-scenario',
        'ds-take-auto-inc',
        'ds-good-take',
        'ds-environment',
        'ds-day-night',
        'ds-project-name',
        'ds-camera',
        'ds-director',
        'ds-camera-operator',
    ].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });

    try {
        const res = await fetch(`/api/control/${encodeURIComponent(host)}/configuration`);
        let data;
        try { data = await res.json(); } catch (_) { data = {}; }

        loadingEl.classList.add('hidden');

        if (!res.ok) {
            errorEl.innerText = data.detail || 'Failed to load configuration.';
            errorEl.classList.remove('hidden');
            return;
        }

        const settings = data.settings || {};
        applyDeckSettingOptions(data.options || {});
        if (sourceEl) {
            const optionsSource = data.options_source === 'device'
                ? 'device-reported'
                : (data.options_source === 'model_profile_preferred'
                    ? 'model capability profile (preferred)'
                : (data.options_source === 'device+model'
                    ? 'device + model profile fallback'
                    : (data.options_source === 'device_partial'
                        ? 'device-reported (partial enumeration)'
                        : (data.options_source === 'model_profile'
                            ? 'model profile fallback'
                            : 'current-values-only (no option list returned by device)'))));
            sourceEl.innerText = `Options source: ${optionsSource} · Current values: device-reported`;
        }
        _renderCurrentSettingsPanel(settings);

        // Pre-fill selects with current values if they match an option
        const fieldMap = {
            'file format': 'ds-file-format',
            'video input': 'ds-video-input',
            'audio input': 'ds-audio-input',
            'audio codec': 'ds-audio-codec',
            'default standard': 'ds-default-standard',
            'audio input channels': 'ds-audio-input-channels',
            'timecode input': 'ds-timecode-input',
            'timecode output': 'ds-timecode-output',
            'audio meters': 'ds-audio-meters',
        };
        Object.entries(fieldMap).forEach(([settingKey, elId]) => {
            const val = settings[settingKey];
            if (!val) return;
            const select = document.getElementById(elId);
            if (!select) return;
            const optionExists = Array.from(select.options).some(o => o.value === val);
            select.value = optionExists ? val : '';
        });

        const extraFieldMap = {
            'reel': 'ds-slate-reel',
            'scene id': 'ds-scene-id',
            'shot type': 'ds-shot-type',
            'take': 'ds-take',
            'take scenario': 'ds-take-scenario',
            'take auto inc': 'ds-take-auto-inc',
            'good take': 'ds-good-take',
            'environment': 'ds-environment',
            'day night': 'ds-day-night',
            'project name': 'ds-project-name',
            'camera': 'ds-camera',
            'director': 'ds-director',
            'camera operator': 'ds-camera-operator',
            'timecode preset': 'ds-timecode-preset',
        };
        Object.entries(extraFieldMap).forEach(([settingKey, inputId]) => {
            setDeckSettingsInputValue(inputId, settings[settingKey] || '');
        });

        renderDeckSettingsTargetHosts();
        renderDeckSettingsScopeToggles();
        await loadDeckSettingsGroups();

        formEl.classList.remove('hidden');
        saveBtn.classList.remove('hidden');
        await loadDeckFormatSlotOptions(host);
    } catch (e) {
        loadingEl.classList.add('hidden');
        errorEl.innerText = `Could not reach backend API for ${host}.`;
        errorEl.classList.remove('hidden');
    }
}

async function loadDeckSettingsDebug() {
    if (!activeDeckSettingsHost) return;
    const debugEl = document.getElementById('deck-settings-debug');
    const debugBtn = document.getElementById('btn-deck-settings-debug');
    if (!debugEl || !debugBtn) return;

    debugBtn.disabled = true;
    debugBtn.innerText = 'Loading…';
    debugEl.innerText = 'Loading diagnostics from device probes...';

    try {
        const res = await fetch(`/api/control/${encodeURIComponent(activeDeckSettingsHost)}/configuration?debug=true`);
        let data;
        try { data = await res.json(); } catch (_) { data = {}; }

        if (!res.ok) {
            debugEl.innerText = `Debug fetch failed: ${data.detail || 'Unknown error'}`;
            return;
        }

        const probes = Array.isArray(data.probes) ? data.probes : [];
        if (probes.length === 0) {
            debugEl.innerText = 'No probe output returned.';
            return;
        }

        const blocks = probes.map((probe) => {
            const cmd = String(probe.command || '');
            const code = String(probe.code ?? '');
            const ok = probe.success ? 'OK' : 'FAIL';
            const status = String(probe.status || '');
            const response = String(probe.response || '');
            return `> ${cmd}\n[${ok}] code=${code} status=${status}\n${response}`;
        });
        debugEl.innerText = blocks.join('\n\n');
    } catch (e) {
        debugEl.innerText = 'Debug fetch failed: Could not reach backend API.';
    } finally {
        debugBtn.disabled = false;
        debugBtn.innerText = 'Reload Debug';
    }
}

function closeDeckSettings() {
    document.getElementById('deck-settings-modal').classList.add('hidden');
    document.body.classList.remove('overflow-hidden');
    activeDeckSettingsHost = '';
    if (deckSettingsLastFocusedElement && typeof deckSettingsLastFocusedElement.focus === 'function') {
        deckSettingsLastFocusedElement.focus();
    }
    deckSettingsLastFocusedElement = null;
}

function isDeckSettingsOpen() {
    const modal = document.getElementById('deck-settings-modal');
    return !!modal && !modal.classList.contains('hidden');
}

function handleDeckSettingsBackdropClick(event) {
    const modal = document.getElementById('deck-settings-modal');
    if (!modal) return;
    if (event.target === modal) closeDeckSettings();
}

function handleDeckSettingsEscape(event) {
    if (event.key !== 'Escape') return;
    const formatConfirmModal = document.getElementById('deck-format-confirm-modal');
    if (formatConfirmModal && !formatConfirmModal.classList.contains('hidden')) {
        closeDeckFormatConfirmDialog();
        return;
    }
    if (isDeckSettingsOpen()) closeDeckSettings();
    if (isDeckRecordingsOpen()) closeDeckRecordings();
    const settingsGroupsModal = document.getElementById('settings-groups-modal');
    if (settingsGroupsModal && !settingsGroupsModal.classList.contains('hidden')) closeSettingsGroupsModal();
}

function getDeckSettingsFocusableElements() {
    const modal = document.getElementById('deck-settings-modal');
    if (!modal || modal.classList.contains('hidden')) return [];

    const selectors = [
        'a[href]',
        'button:not([disabled])',
        'input:not([disabled]):not([type="hidden"])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        '[tabindex]:not([tabindex="-1"])',
    ];

    return Array.from(modal.querySelectorAll(selectors.join(','))).filter((el) => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
    });
}

function handleDeckSettingsTabTrap(event) {
    if (event.key !== 'Tab' || !isDeckSettingsOpen()) return;

    const focusable = getDeckSettingsFocusableElements();
    if (focusable.length === 0) {
        event.preventDefault();
        return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === first || !focusable.includes(active))) {
        event.preventDefault();
        last.focus();
        return;
    }

    if (!event.shiftKey && (active === last || !focusable.includes(active))) {
        event.preventDefault();
        first.focus();
    }
}

document.addEventListener('keydown', handleDeckSettingsEscape);
document.addEventListener('keydown', handleDeckSettingsTabTrap);

async function saveDeckSettings() {
    if (!activeDeckSettingsHost) return;
    const requestHost = activeDeckSettingsHost;
    const statusEl = document.getElementById('deck-settings-status');
    const saveBtn = document.getElementById('btn-save-deck-settings');

    const settings = collectDeckSettingsValues();

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
        let data;
        try { data = await res.json(); } catch (_) { data = {}; }

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
        if (statusEl) statusEl.innerText = 'Could not reach backend API.';
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
        'default standard': 'Default Standard',
        'audio input channels': 'Audio Input Channels',
        'timecode input': 'Timecode Input',
        'timecode output': 'Timecode Output',
        'timecode preset': 'Timecode Preset',
        'audio meters': 'Audio Meters',
        'reel': 'Reel',
        'scene id': 'Scene ID',
        'shot type': 'Shot Type',
        'take': 'Take',
        'take scenario': 'Take Scenario',
        'take auto inc': 'Take Auto Increment',
        'good take': 'Good Take',
        'environment': 'Environment',
        'day night': 'Day/Night',
        'project name': 'Project Name',
        'camera': 'Camera',
        'director': 'Director',
        'camera operator': 'Camera Operator',
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
    insertSlateGlobalTemplate,
    insertSlatePerDeckTemplate,
    clearActiveEventContext,
    triggerPluginSync,
    addManualScheduleRow,
    selectActiveFromRow,
    saveScheduleFromMatrix,
    uploadScheduleFile,
    openNativePicker,
    openSiblingPicker,
    toggleSlateFields,
    toggleEventSlateFields,
    toggleDeckSlateSection,
    insertEventSlateTemplate,
    formatDeckCard,
    closeDeckFormatConfirmDialog,
    handleDeckFormatConfirmBackdropClick,
    confirmDeckFormatAction,
    openDeckRecordings,
    closeDeckRecordings,
    handleDeckRecordingsBackdropClick,
    openSettingsGroupsModal,
    closeSettingsGroupsModal,
    handleSettingsGroupsBackdropClick,
    onSettingsGroupsGroupSelected,
    onSettingsGroupsTargetSelectionChanged,
    setSettingsGroupsTargetsAll,
    setSettingsGroupsScopeAll,
    applySettingsGroupsScopePreset,
    saveSettingsGroupsGroup,
    applySettingsGroupsGroup,
    deleteSettingsGroupsGroup,
    applySettingsGroupsDraftToSelected,
    loadDeckRecordingsList,
    transferDeckRecording,
    onDeckClipSelectionChanged,
    selectClipForPlayback,
    loadDeckClipOptions,
    uploadDeckPlaybackFile,
    cueDeckPlayback,
    playDeckNow,
    scheduleDeckPlayback,
    cancelDeckPlaybackSchedule,
    playDeckNowFromCard,
    sendDeckCommand,
    sendCommandToAll,
    openDeckSettings,
    closeDeckSettings,
    handleDeckSettingsBackdropClick,
    saveDeckSettings,
    setDeckSettingsScopeAll,
    onDeckSettingsGroupSelected,
    applyDeckSettingsToSelectedTargets,
    saveDeckSettingsGroup,
    applyDeckSettingsGroup,
    deleteDeckSettingsGroup,
    loadDeckSettingsDebug,
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
let _dashboardPollInterval = null;
function _startDashboardPolling() {
    if (_dashboardPollInterval) return;
    _dashboardPollInterval = setInterval(updateDashboardMetrics, 2000);
}
function _stopDashboardPolling() {
    if (_dashboardPollInterval) { clearInterval(_dashboardPollInterval); _dashboardPollInterval = null; }
}
document.addEventListener('visibilitychange', () => {
    if (document.hidden) { _stopDashboardPolling(); } else { _startDashboardPolling(); updateDashboardMetrics(); }
});
_startDashboardPolling();
updateDashboardMetrics();
loadPluginManagerSystem();