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

// --- Service Detection & API Bases ---
const THIS_PORT = window.location.port;
const IS_WP = THIS_PORT === '8009';
const IS_HD = THIS_PORT === '8008' || THIS_PORT === '';

const HD_API_BASE = IS_HD ? '' : `${window.location.protocol}//${window.location.hostname}:8008`;
const WP_API_BASE = IS_WP ? '' : `${window.location.protocol}//${window.location.hostname}:8009`;

let servicesAvailable = { hyperdeck: IS_HD, webpresenter: IS_WP };
let activeTab = localStorage.getItem('activeTab') || (IS_WP ? 'webpresenter' : 'hyperdeck');

// --- Web Presenter State ---
let wpStateCache = {};
let wpSseSource = null;
let wpPresentersConfig = {};
let wpKeyPlugins = [];
let wpPollInterval = null;

function showToast(message, type = 'info', durationMs = 4000) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span class="flex-1">${escHtml(message)}</span><button onclick="this.parentElement.remove()" class="text-current opacity-50 hover:opacity-100 cursor-pointer">&times;</button>`;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    if (durationMs > 0) setTimeout(() => { toast.classList.remove('show'); toast.classList.add('hide'); setTimeout(() => toast.remove(), 300); }, durationMs);
}
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

let expandedStreamRows = new Set();

function toggleEventStreamFields(buttonEl) {
    const row = buttonEl.closest('.schedule-row-item');
    if (!row) return;
    const fields = row.querySelector('.sch-stream-fields');
    if (!fields) return;
    const key = row.dataset.rowKey;
    const shouldShow = fields.style.display === 'none' || fields.classList.contains('hidden');
    fields.style.display = shouldShow ? '' : 'none';
    fields.classList.remove('hidden');
    buttonEl.innerText = shouldShow ? 'Hide Stream Settings' : 'Stream Settings';
    if (shouldShow) {
        expandedStreamRows.add(key);
        const select = fields.querySelector('.sch-stream-profile');
        if (select) {
            const current = select.value || '';
            loadWpProfilesIntoSelect(select, current);
            if (current) {
                fields.querySelectorAll('input, select').forEach(f => {
                    if (f.classList.contains('sch-stream-profile')) return;
                    f.disabled = true;
                    f.classList.add('opacity-60');
                });
            }
        }
    } else {
        expandedStreamRows.delete(key);
    }
}

function loadWpProfilesIntoSelect(select, currentValue) {
    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/profiles` : '/api/wp/profiles';
    fetch(url).then(r => r.json()).then(profiles => {
        select.innerHTML = '<option value="">None</option>';
        (Array.isArray(profiles) ? profiles : []).forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.name;
            opt.textContent = p.name;
            if (p.name === currentValue) opt.selected = true;
            select.appendChild(opt);
        });
    }).catch(() => {});
}

function wpRefreshAllProfileSelects() {
    wpLoadApplyProfileSelect();
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

/** Escape a string for safe use in HTML attribute values. */
function escAttr(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
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

        // Read stream settings - use closest() to find within the hidden container
        const streamFields = el.querySelector('.sch-stream-fields');
        const getStreamVal = (cls) => {
            if (!streamFields) return '';
            const input = streamFields.querySelector(cls);
            return input ? input.value : '';
        };

        const protocol = getStreamVal('.sch-protocol') || 'rtmp';
        const quality = getStreamVal('.sch-quality') || '';
        const videoMode = getStreamVal('.sch-video-mode') || '';
        const primaryUrl = getStreamVal('.sch-primary-url') || '';
        const primaryKey = getStreamVal('.sch-primary-key') || '';
        const backupUrl = getStreamVal('.sch-backup-url') || '';
        const backupKey = getStreamVal('.sch-backup-key') || '';
        const streamProfile = getStreamVal('.sch-stream-profile') || '';

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
            protocol,
            quality,
            video_mode: videoMode,
            primary_url: primaryUrl,
            primary_key: primaryKey,
            backup_url: backupUrl,
            backup_key: backupKey,
            stream_profile: streamProfile,
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
            protocol: row.protocol || 'rtmp',
            quality: row.quality || '',
            video_mode: row.video_mode || '',
            primary_url: row.primary_url || '',
            primary_key: row.primary_key || '',
            backup_url: row.backup_url || '',
            backup_key: row.backup_key || '',
            stream_profile: row.stream_profile || '',
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
    showToast('Per-deck slate metadata is configured in each Deck Settings panel.', 'info');
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
        const res = await fetch(HD_API_BASE + '/api/state');
        if (!res.ok) return;
        const state = await res.json();
        const container = document.getElementById('decks-container');

        // Keep the staging HUD aligned with backend auto-selected active context.
        try {
            const activeContextRes = await fetch(HD_API_BASE + '/api/schedule/active');
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
        const res = await fetch(HD_API_BASE + '/api/config');
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
        loadStorageDestinations();
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
        <input type="text" placeholder="/mnt/storage/ingest" aria-label="Destination path" value="${escHtml(path)}" class="dest-path block w-full rounded-md border-0 bg-slate-950 px-2 py-1 text-xs text-white ring-1 ring-inset ring-slate-800 focus:outline-none font-mono">
        <button onclick="openFolderBrowser(this.previousElementSibling)" class="text-xs text-indigo-400 hover:text-indigo-300 font-medium cursor-pointer p-1" title="Browse host directory">📁</button>
        <button onclick="this.parentElement.remove()" class="text-rose-500 text-xs px-1 hover:text-rose-400 cursor-pointer">✕</button>
    `;
    return div;
}

function addDestinationRow(path = '') {
    document.getElementById('cfg-destinations-list').appendChild(createDestinationRowElement(path));
}

// --- Storage Plugin Destinations Management ---
let availableStoragePlugins = [];
let currentStorageDestConfig = {};
let previousStoragePluginType = '';

async function loadStorageDestinations() {
    const list = document.getElementById('cfg-storage-destinations-list');
    if (!list) return;

    try {
        const [pluginsRes, destsRes] = await Promise.all([
            fetch(HD_API_BASE + '/api/storage-plugins'),
            fetch(HD_API_BASE + '/api/storage-destinations'),
        ]);
        const plugins = await pluginsRes.json();
        const destsData = await destsRes.json();
        availableStoragePlugins = Array.isArray(plugins) ? plugins : [];
        const destinations = destsData.storage_destinations || [];

        if (destinations.length === 0) {
            list.innerHTML = '<div class="text-[11px] text-slate-500 px-2 py-2">No storage plugins configured.</div>';
            return;
        }

        list.innerHTML = '';
        destinations.forEach(dest => {
            const row = document.createElement('div');
            row.className = 'flex gap-2 items-center px-2 py-2 border border-slate-800 rounded bg-slate-950 text-[11px]';
            const pluginLabel = availableStoragePlugins.find(p => p.storage_type === dest.plugin_type)?.label || dest.plugin_type;
            const queue = dest.queue_status || {};
            const queueSummary = [];
            if (queue.active > 0) queueSummary.push(`${queue.active} active`);
            if (queue.pending > 0) queueSummary.push(`${queue.pending} queued`);
            if (queue.completed > 0) queueSummary.push(`${queue.completed} done`);
            const queueText = queueSummary.length > 0 ? queueSummary.join(', ') : 'Idle';

            row.innerHTML = `
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                        <span class="text-slate-200 font-medium truncate">${escHtml(dest.label)}</span>
                        <span class="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">${escHtml(pluginLabel)}</span>
                        ${dest.enabled ? '<span class="w-1.5 h-1.5 bg-emerald-400 rounded-full"></span>' : '<span class="w-1.5 h-1.5 bg-slate-600 rounded-full"></span>'}
                    </div>
                    <div class="text-[10px] text-slate-500 mt-0.5">Queue: ${escHtml(queueText)}</div>
                </div>
                <div class="flex items-center gap-1">
                    <button onclick="editStorageDestination('${escAttr(dest.id)}')" class="text-[10px] bg-slate-800 text-slate-300 border border-slate-700 rounded px-2 py-1 hover:bg-slate-700 hover:text-white transition cursor-pointer">Edit</button>
                    <button onclick="deleteStorageDestination('${escAttr(dest.id)}', '${escAttr(dest.label)}')" class="text-[10px] bg-rose-600/20 text-rose-300 border border-rose-500/30 rounded px-2 py-1 hover:bg-rose-600 hover:text-white transition cursor-pointer">Del</button>
                </div>
            `;
            list.appendChild(row);
        });
    } catch (e) {
        console.error('Failed to load storage destinations:', e);
        list.innerHTML = '<div class="text-[11px] text-rose-400 px-2 py-2">Failed to load storage destinations.</div>';
    }
}

function openStorageDestModal(editDest = null) {
    const modal = document.getElementById('storage-dest-modal');
    const subtitle = document.getElementById('storage-dest-modal-subtitle');
    const typeSelect = document.getElementById('sd-plugin-type');
    const editId = document.getElementById('sd-edit-id');
    const label = document.getElementById('sd-label');
    const enabled = document.getElementById('sd-enabled');
    const maxConcurrent = document.getElementById('sd-max-concurrent');
    const testStatus = document.getElementById('sd-test-status');

    // Populate plugin type dropdown
    typeSelect.innerHTML = '<option value="">Select a storage plugin...</option>';
    availableStoragePlugins.filter(p => p.enabled).forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.storage_type;
        opt.textContent = `${p.label} - ${p.description}`;
        typeSelect.appendChild(opt);
    });

    if (editDest) {
        subtitle.textContent = 'Edit storage destination';
        editId.value = editDest.id;
        typeSelect.value = editDest.plugin_type;
        label.value = editDest.label || '';
        enabled.checked = editDest.enabled !== false;
        maxConcurrent.value = editDest.max_concurrent || 1;
        currentStorageDestConfig = editDest.config || {};
        previousStoragePluginType = editDest.plugin_type || '';
        onStoragePluginTypeChanged();
        // Restore field values
        setTimeout(() => {
            Object.entries(currentStorageDestConfig).forEach(([key, val]) => {
                const input = document.getElementById(`sd-field-${key}`);
                if (input) input.value = val;
            });
        }, 50);
    } else {
        subtitle.textContent = 'Add a new storage destination';
        editId.value = '';
        typeSelect.value = '';
        label.value = '';
        enabled.checked = true;
        maxConcurrent.value = 1;
        currentStorageDestConfig = {};
        previousStoragePluginType = '';
        document.getElementById('sd-config-fields').innerHTML = '';
    }
    testStatus.textContent = '';
    modal.classList.remove('hidden');
}

function closeStorageDestModal() {
    document.getElementById('storage-dest-modal').classList.add('hidden');
}

function onStoragePluginTypeChanged() {
    const typeSelect = document.getElementById('sd-plugin-type');
    const fieldsContainer = document.getElementById('sd-config-fields');
    const labelInput = document.getElementById('sd-label');
    const storageType = typeSelect.value;
    const plugin = availableStoragePlugins.find(p => p.storage_type === storageType);

    if (!plugin) {
        fieldsContainer.innerHTML = '';
        previousStoragePluginType = storageType;
        return;
    }

    const prevPlugin = availableStoragePlugins.find(p => p.storage_type === previousStoragePluginType);
    const prevLabel = prevPlugin ? prevPlugin.label : '';
    if (!labelInput.value || labelInput.value === prevLabel) {
        labelInput.value = plugin.label;
    }
    previousStoragePluginType = storageType;

    fieldsContainer.innerHTML = '';
    (plugin.config_fields || []).forEach(field => {
        const wrapper = document.createElement('div');
        const fieldType = field.type === 'password' ? 'password' : 'text';
        wrapper.innerHTML = `
            <label class="block text-xs text-slate-400 mb-1">${escHtml(field.label)}${field.required ? ' *' : ''}</label>
            <input id="sd-field-${escAttr(field.key)}" type="${fieldType}" placeholder="${escAttr(field.default || '')}" value="${escAttr(currentStorageDestConfig[field.key] || field.default || '')}" class="w-full rounded bg-slate-950 border border-slate-800 text-xs px-2 py-1.5 text-slate-300 focus:outline-none font-mono">
        `;
        fieldsContainer.appendChild(wrapper);
    });
}

async function testStorageConnection() {
    const typeSelect = document.getElementById('sd-plugin-type');
    const testStatus = document.getElementById('sd-test-status');
    const storageType = typeSelect.value;
    if (!storageType) {
        testStatus.textContent = 'Select a plugin type first.';
        testStatus.className = 'text-[11px] text-amber-400';
        return;
    }

    const config = collectStorageConfigFields();
    testStatus.textContent = 'Testing...';
    testStatus.className = 'text-[11px] text-slate-400';

    try {
        const res = await fetch(`/api/storage-plugins/${encodeURIComponent(storageType)}/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config }),
        });
        const data = await res.json();
        if (data.ok) {
            testStatus.textContent = data.message || 'Connection OK';
            testStatus.className = 'text-[11px] text-emerald-400';
        } else {
            testStatus.textContent = data.message || 'Connection failed';
            testStatus.className = 'text-[11px] text-rose-400';
        }
    } catch (e) {
        testStatus.textContent = 'Test failed: could not reach backend.';
        testStatus.className = 'text-[11px] text-rose-400';
    }
}

function collectStorageConfigFields() {
    const config = {};
    const plugin = availableStoragePlugins.find(p => p.storage_type === document.getElementById('sd-plugin-type').value);
    if (!plugin) return config;
    (plugin.config_fields || []).forEach(field => {
        const input = document.getElementById(`sd-field-${field.key}`);
        if (input) config[field.key] = input.value.trim();
    });
    return config;
}

async function saveStorageDestination() {
    const editId = document.getElementById('sd-edit-id').value;
    const storageType = document.getElementById('sd-plugin-type').value;
    const label = document.getElementById('sd-label').value.trim();
    const enabled = document.getElementById('sd-enabled').checked;
    const maxConcurrent = parseInt(document.getElementById('sd-max-concurrent').value || '1', 10);
    const config = collectStorageConfigFields();

    if (!storageType) {
        showToast('Select a plugin type.', 'warning');
        return;
    }
    if (!label) {
        showToast('Enter a label for this destination.', 'warning');
        return;
    }

    try {
        const res = await fetch(HD_API_BASE + '/api/storage-destinations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: editId || undefined,
                plugin_type: storageType,
                label,
                enabled,
                max_concurrent: maxConcurrent,
                config,
            }),
        });
        const data = await res.json();
        if (!res.ok) {
            showToast(`Save failed: ${data.detail || 'Unknown error'}`, 'error');
            return;
        }
        closeStorageDestModal();
        loadStorageDestinations();
        showToast('Storage destination saved.', 'success');
    } catch (e) {
        showToast('Save failed: Could not reach backend.', 'error');
    }
}

async function editStorageDestination(destId) {
    try {
        const res = await fetch(HD_API_BASE + '/api/storage-destinations');
        const data = await res.json();
        const dest = (data.storage_destinations || []).find(d => d.id === destId);
        if (dest) openStorageDestModal(dest);
    } catch (e) {
        showToast('Failed to load destination.', 'error');
    }
}

async function deleteStorageDestination(destId, label) {
    if (!confirm(`Delete storage destination "${label}"?`)) return;
    try {
        const res = await fetch(`/api/storage-destinations/${encodeURIComponent(destId)}`, { method: 'DELETE' });
        if (res.ok) {
            loadStorageDestinations();
            showToast('Storage destination deleted.', 'success');
        } else {
            showToast('Delete failed.', 'error');
        }
    } catch (e) {
        showToast('Delete failed: Could not reach backend.', 'error');
    }
}

// --- Dynamic Device Mapping Rows Management ---
function renderConfigDecksList() {
    const list = document.getElementById('cfg-decks-list');
    list.innerHTML = '';
    const deckStages = localConfigCache.deck_stages || {};
    for (const [name, value] of Object.entries(localConfigCache.hyperdecks)) {
        let ip = '', port = '9993';
        if (typeof value === 'object' && value !== null) {
            ip = value.ip || '';
            port = String(value.port || '9993');
        } else {
            ip = String(value || '');
        }
        list.appendChild(createDeckRowElement(name, ip, deckStages[name] || '', port));
    }
}

function createDeckRowElement(name='', ip='', stage='', port='9993') {
    const div = document.createElement('div');
    div.className = 'flex gap-2 items-center row-deck-item';
    div.innerHTML = `
        <input type="text" placeholder="Device Label" aria-label="Device name" value="${escHtml(name)}" class="d-name block w-1/4 rounded-md border-0 bg-slate-950 px-2 py-1 text-xs text-white ring-1 ring-inset ring-slate-800 focus:outline-none">
        <input type="text" placeholder="IP / Hostname" aria-label="IP address or hostname" value="${escHtml(ip)}" class="d-ip block w-1/4 rounded-md border-0 bg-slate-950 px-2 py-1 text-xs text-white ring-1 ring-inset ring-slate-800 focus:outline-none">
        <input type="number" placeholder="Port" aria-label="TCP port" value="${escHtml(port)}" class="d-port block w-1/6 rounded-md border-0 bg-slate-950 px-2 py-1 text-xs text-white ring-1 ring-inset ring-slate-800 focus:outline-none">
        <input type="text" list="cfg-stage-options" placeholder="Stage" aria-label="Stage name" value="${escHtml(stage)}" class="d-stage block w-1/4 rounded-md border-0 bg-slate-950 px-2 py-1 text-xs text-white ring-1 ring-inset ring-slate-800 focus:outline-none">
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
        const port = parseInt(el.querySelector('.d-port').value.trim() || '9993', 10);
        const stage = el.querySelector('.d-stage').value.trim();
        if(name && ip) {
            if (port && port !== 9993) {
                hyperdecks[name] = { ip, port };
            } else {
                hyperdecks[name] = ip;
            }
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
        const res = await fetch(HD_API_BASE + '/api/config', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        if(res.ok) {
            const data = await res.json().catch(() => ({}));
            const warnings = data.warnings || [];
            if (warnings.length > 0) {
                showToast(`Saved with warnings: ${warnings.join('; ')}`, 'warning', 6000);
            } else {
                showToast('Configuration updated and reloaded cleanly!', 'success');
            }
            if (slateStatus) slateStatus.innerText = 'Slate metadata saved.';
            pullConfigurationMatrix();
        }
    } catch (e) { showToast("Error trying to commit target configurations modifications.", 'error'); }
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
        const res = await fetch(HD_API_BASE + '/api/discover');
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
                    <button ${alreadyAdded ? 'disabled' : `onclick="addDeckToConfigRow('New_HyperDeck', '${escAttr(ip)}')"`} class="text-xs px-2 py-1 rounded border transition ${alreadyAdded ? 'bg-emerald-600/10 text-emerald-300 border-emerald-500/30 cursor-not-allowed' : 'bg-indigo-600/30 text-indigo-400 border-indigo-500/30 hover:bg-indigo-600 hover:text-white cursor-pointer'}">
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
                <button onclick="navigateFolder('${escAttr(nestedFullPath.replace(/\\/g, '\\\\'))}')" class="text-left w-full flex items-center gap-2 font-medium hover:text-white cursor-pointer truncate">
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
    renderQuickAccessSidebar();
    navigateFolder(inputEl && inputEl.value ? inputEl.value : "");
}

function renderQuickAccessSidebar() {
    const list = document.getElementById('modal-quick-access');
    if (!list) return;
    list.innerHTML = '<li class="text-slate-500 text-[10px] px-2 py-1">Loading...</li>';
    fetch(HD_API_BASE + '/api/browse/roots').then(r => r.json()).then(data => {
        list.innerHTML = '';
        const roots = data.roots || [];
        roots.forEach(root => {
            const label = root === '' ? '~ Home' : root;
            const li = document.createElement('li');
            li.innerHTML = `<button onclick="navigateFolder('${escHtml(root.replace(/\\/g, '\\\\'))}')" class="w-full text-left px-2 py-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-white cursor-pointer truncate" title="${escHtml(root)}">${escHtml(label)}</button>`;
            list.appendChild(li);
        });
    }).catch(() => {
        list.innerHTML = '<li class="text-slate-500 text-[10px] px-2 py-1">Failed to load</li>';
    });
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
        const response = await fetch(HD_API_BASE + '/api/schedule/active', {
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
    div.draggable = true;
    div.innerHTML = `
        <div class="grid grid-cols-12 gap-2 items-end">
            <div class="col-span-1 flex items-center justify-center cursor-grab active:cursor-grabbing text-slate-600 hover:text-slate-400 drag-handle" title="Drag to reorder">⠿</div>
            <label class="col-span-3 text-[10px] text-slate-400 space-y-1">
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
        <div class="mt-1.5 wp-stream-toggle" style="display:none">
            <button type="button" onclick="toggleEventStreamFields(this)" class="text-[10px] text-slate-400 hover:text-slate-200 font-medium cursor-pointer">Stream Settings</button>
            <div class="sch-stream-fields hidden mt-2 grid grid-cols-3 gap-2">
                <label class="text-[10px] text-slate-400 space-y-1">
                    <span class="block">Protocol</span>
                    <select onchange="wpOnRowProtocolChanged(this)" class="sch-protocol block w-full rounded border border-slate-800 bg-slate-950 text-[11px] px-2 py-1 text-slate-200 focus:outline-none">
                        <option value="rtmp" ${item.protocol === 'rtmp' || !item.protocol ? 'selected' : ''}>RTMP</option>
                        <option value="srt" ${item.protocol === 'srt' ? 'selected' : ''}>SRT</option>
                    </select>
                </label>
                <label class="text-[10px] text-slate-400 space-y-1">
                    <span class="block">Quality</span>
                    <select class="sch-quality block w-full rounded border border-slate-800 bg-slate-950 text-[11px] px-2 py-1 text-slate-200 focus:outline-none">
                        <option value="Streaming High" ${item.quality === 'Streaming High' ? 'selected' : ''}>Streaming High</option>
                        <option value="Streaming Medium" ${item.quality === 'Streaming Medium' || !item.quality ? 'selected' : ''}>Streaming Medium</option>
                        <option value="Streaming Low" ${item.quality === 'Streaming Low' ? 'selected' : ''}>Streaming Low</option>
                        <option value="HyperDeck High" ${item.quality === 'HyperDeck High' ? 'selected' : ''}>HyperDeck High</option>
                        <option value="HyperDeck Medium" ${item.quality === 'HyperDeck Medium' ? 'selected' : ''}>HyperDeck Medium</option>
                        <option value="HyperDeck Low" ${item.quality === 'HyperDeck Low' ? 'selected' : ''}>HyperDeck Low</option>
                    </select>
                </label>
                <label class="text-[10px] text-slate-400 space-y-1">
                    <span class="block">Video Mode</span>
                    <select class="sch-video-mode block w-full rounded border border-slate-800 bg-slate-950 text-[11px] px-2 py-1 text-slate-200 focus:outline-none">
                        <option value="Auto" ${item.video_mode === 'Auto' || !item.video_mode ? 'selected' : ''}>Auto</option>
                        <option value="1080p59.94" ${item.video_mode === '1080p59.94' ? 'selected' : ''}>1080p59.94</option>
                        <option value="1080p50" ${item.video_mode === '1080p50' ? 'selected' : ''}>1080p50</option>
                        <option value="1080p30" ${item.video_mode === '1080p30' ? 'selected' : ''}>1080p30</option>
                        <option value="720p60" ${item.video_mode === '720p60' ? 'selected' : ''}>720p60</option>
                    </select>
                </label>
                <label class="text-[10px] text-slate-400 space-y-1 ${(item.protocol || 'rtmp') === 'srt' ? 'hidden' : ''}">
                    <span class="block">Primary URL</span>
                    <input type="text" value="${escAttr(item.primary_url || '')}" placeholder="rtmp://..." class="sch-primary-url block w-full rounded border border-slate-800 bg-slate-950 text-[11px] px-2 py-1 text-slate-200 focus:outline-none font-mono">
                </label>
                <label class="text-[10px] text-slate-400 space-y-1 ${(item.protocol || 'rtmp') === 'srt' ? 'hidden' : ''}">
                    <span class="block">Primary Key</span>
                    <input type="password" value="${escAttr(item.primary_key || '')}" placeholder="stream-key" class="sch-primary-key block w-full rounded border border-slate-800 bg-slate-950 text-[11px] px-2 py-1 text-slate-200 focus:outline-none font-mono">
                </label>
                <label class="text-[10px] text-slate-400 space-y-1 ${(item.protocol || 'rtmp') === 'srt' ? 'hidden' : ''}">
                    <span class="block">Backup URL</span>
                    <input type="text" value="${escAttr(item.backup_url || '')}" placeholder="rtmp://..." class="sch-backup-url block w-full rounded border border-slate-800 bg-slate-950 text-[11px] px-2 py-1 text-slate-200 focus:outline-none font-mono">
                </label>
                <label class="text-[10px] text-slate-400 space-y-1 ${(item.protocol || 'rtmp') === 'srt' ? 'hidden' : ''}">
                    <span class="block">Backup Key</span>
                    <input type="password" value="${escAttr(item.backup_key || '')}" placeholder="stream-key" class="sch-backup-key block w-full rounded border border-slate-800 bg-slate-950 text-[11px] px-2 py-1 text-slate-200 focus:outline-none font-mono">
                </label>
                <label class="text-[10px] text-slate-400 space-y-1 ${(item.protocol || 'rtmp') === 'rtmp' ? 'hidden' : ''}">
                    <span class="block">SRT Primary</span>
                    <input type="text" value="${escAttr(item.primary_url || '')}" placeholder="srt://host:port?streamid=..." class="sch-srt-primary block w-full rounded border border-slate-800 bg-slate-950 text-[11px] px-2 py-1 text-slate-200 focus:outline-none font-mono">
                </label>
                <label class="text-[10px] text-slate-400 space-y-1 ${(item.protocol || 'rtmp') === 'rtmp' ? 'hidden' : ''}">
                    <span class="block">SRT Passphrase</span>
                    <input type="password" value="${escAttr(item.primary_key || '')}" placeholder="optional" class="sch-srt-passphrase block w-full rounded border border-slate-800 bg-slate-950 text-[11px] px-2 py-1 text-slate-200 focus:outline-none font-mono">
                </label>
                <label class="text-[10px] text-slate-400 space-y-1 ${(item.protocol || 'rtmp') === 'rtmp' ? 'hidden' : ''}">
                    <span class="block">SRT Backup</span>
                    <input type="text" value="${escAttr(item.backup_url || '')}" placeholder="srt://host:port?streamid=..." class="sch-srt-backup block w-full rounded border border-slate-800 bg-slate-950 text-[11px] px-2 py-1 text-slate-200 focus:outline-none font-mono">
                </label>
                <label class="text-[10px] text-slate-400 space-y-1 ${(item.protocol || 'rtmp') === 'rtmp' ? 'hidden' : ''}">
                    <span class="block">SRT Backup Passphrase</span>
                    <input type="password" value="${escAttr(item.backup_key || '')}" placeholder="optional" class="sch-srt-backup-passphrase block w-full rounded border border-slate-800 bg-slate-950 text-[11px] px-2 py-1 text-slate-200 focus:outline-none font-mono">
                </label>
                <label class="text-[10px] text-slate-400 space-y-1">
                    <span class="block">Stream Profile</span>
                    <select onchange="wpOnRowProfileChanged(this)" class="sch-stream-profile block w-full rounded border border-slate-800 bg-slate-950 text-[11px] px-2 py-1 text-slate-200 focus:outline-none">
                        <option value="">None</option>
                        ${item.stream_profile ? `<option value="${escAttr(item.stream_profile)}" selected>${escHtml(item.stream_profile)}</option>` : ''}
                    </select>
                </label>
            </div>
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
            return {
                _row_key: stableKey, id, planned_title: plannedTitle, start_time, stage, slate_metadata,
                protocol: row.protocol || 'rtmp',
                quality: row.quality || '',
                video_mode: row.video_mode || '',
                primary_url: row.primary_url || '',
                primary_key: row.primary_key || '',
                backup_url: row.backup_url || '',
                backup_key: row.backup_key || '',
                stream_profile: row.stream_profile || '',
            };
        })
        .filter(row => row.id || row.planned_title || row.start_time);

    scheduleDataCache = normalizedRows;
    const payload = normalizedRows.map(({ id, planned_title, start_time, stage, slate_metadata }) => ({ id, planned_title, start_time, stage, slate_metadata }));

    await fetch(HD_API_BASE + '/api/schedule', {
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

let wpScheduleSaveDebounceTimer = null;

function requestWpScheduleSaveDebounced() {
    if (wpScheduleSaveDebounceTimer) {
        clearTimeout(wpScheduleSaveDebounceTimer);
    }

    wpScheduleSaveDebounceTimer = setTimeout(async () => {
        wpScheduleSaveDebounceTimer = null;
        try {
            mergeVisibleRowsIntoCache();
            const url = HD_API_BASE ? `${HD_API_BASE}/api/schedule` : '/api/schedule';
            await fetch(url, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(scheduleDataCache),
            });
        } catch (_) {}
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
        showToast('Please set an event ID before selecting active context.', 'warning');
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
        showToast('Select a schedule plugin first.', 'warning');
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
            showToast(data.detail || 'Plugin sync failed.', 'error');
            syncStatus.innerText = `Sync failed: ${data.detail || 'Unknown plugin error'}`;
            return;
        }

        const scheduleRes = await fetch(HD_API_BASE + '/api/schedule');
        const schedule = await scheduleRes.json();
        renderScheduleMatrix(schedule);

        const count = Array.isArray(schedule) ? schedule.length : 0;
        syncStatus.innerText = `Last sync: ${count} rows loaded from ${plugin}`;
    } catch (e) {
        showToast('Plugin sync request failed.', 'error');
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
        showToast('Select a plugin first.', 'warning');
        return;
    }

    const file = fileInput.files && fileInput.files[0];
    if (!file) {
        showToast('Choose an .xlsx file first.', 'warning');
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

        const scheduleRes = await fetch(HD_API_BASE + '/api/schedule');
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
    await fetch(HD_API_BASE + '/api/schedule', {
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
            showToast(`Command failed on ${host}: ${data.detail || 'Unknown error'}`, 'error');
        } else {
            console.info(`${label} on ${host}:`, data.response);
            updateDashboardMetrics();
        }
    } catch (e) {
        showToast(`Could not reach backend API for ${host}.`, 'error');
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
            showToast(`${label} failed: ${data.detail || 'Unknown error'}`, 'error');
            return;
        }
        const results = data.results || [];
        const failed = results.filter(r => !r.success);
        if (failed.length > 0) {
            const names = failed.map(r => r.name || r.host).join(', ');
            showToast(`${label}: command failed on ${failed.length} deck(s): ${names}`, 'error');
        }
    } catch (e) {
        showToast(`${label}: could not reach server.`, 'error');
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
    const res = await fetch(HD_API_BASE + '/api/control/settings-groups');
    if (!res.ok) return {};
    const data = await res.json();
    return (data && typeof data.groups === 'object' && data.groups) ? data.groups : {};
}

async function _saveSettingsGroup(name, targets, settings, field_keys) {
    const res = await fetch(HD_API_BASE + '/api/control/settings-groups', {
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
        const res = await fetch(HD_API_BASE + '/api/control/apply-settings', {
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
        const res = await fetch(HD_API_BASE + '/api/control/apply-settings', {
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
            row.className = 'grid grid-cols-14 gap-2 items-center px-2 py-2 border-b border-slate-800 last:border-b-0 text-[11px]';

            const name = String(item.name || '');
            const size = formatBytes(item.size || 0);
            const modified = formatDeckModified(item.modified || '');
            const transferStatus = String(item.transfer_status || 'not_transferred');

            const nameEl = document.createElement('div');
            nameEl.className = 'col-span-5 text-slate-200 truncate';
            nameEl.title = name;
            nameEl.textContent = name;

            const metaEl = document.createElement('div');
            metaEl.className = 'col-span-3 text-slate-500 truncate';
            metaEl.title = modified ? `${size} · ${modified}` : size;
            metaEl.textContent = modified ? `${size} · ${modified}` : size;

            const statusEl = document.createElement('div');
            statusEl.className = 'col-span-3 flex items-center gap-1.5';
            if (transferStatus === 'completed') {
                statusEl.innerHTML = '<span class="inline-flex items-center gap-1 text-[10px] text-emerald-400"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>Transferred</span>';
            } else if (transferStatus === 'in_progress') {
                statusEl.innerHTML = '<span class="inline-flex items-center gap-1 text-[10px] text-amber-400"><span class="w-1.5 h-1.5 bg-amber-400 rounded-full animate-pulse"></span>Transferring</span>';
            } else if (transferStatus === 'failed') {
                statusEl.innerHTML = '<span class="inline-flex items-center gap-1 text-[10px] text-rose-400"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>Failed</span>';
            }

            const btnWrap = document.createElement('div');
            btnWrap.className = 'col-span-3 flex justify-end';

            const clipId = findDeckClipIdByName(name);

            const pickBtn = document.createElement('button');
            pickBtn.type = 'button';
            pickBtn.className = 'text-[10px] bg-slate-800 text-slate-300 border border-slate-700 rounded px-2 py-1 hover:bg-slate-700 hover:text-white transition cursor-pointer mr-1';
            pickBtn.textContent = 'Use';
            pickBtn.addEventListener('click', () => selectClipForPlayback(name, clipId));

            const btn = document.createElement('button');
            btn.type = 'button';
            if (transferStatus === 'completed') {
                btn.className = 'text-[10px] bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 rounded px-2 py-1 cursor-not-allowed opacity-60';
                btn.textContent = 'Done';
                btn.disabled = true;
            } else if (transferStatus === 'in_progress') {
                btn.className = 'text-[10px] bg-amber-600/20 text-amber-300 border border-amber-500/30 rounded px-2 py-1 cursor-not-allowed opacity-60';
                btn.textContent = 'Active';
                btn.disabled = true;
            } else {
                btn.className = 'text-[10px] bg-indigo-600/20 text-indigo-300 border border-indigo-500/30 rounded px-2 py-1 hover:bg-indigo-600 hover:text-white transition cursor-pointer';
                btn.textContent = 'Transfer';
                btn.addEventListener('click', () => transferDeckRecording(name));
            }
            btnWrap.appendChild(pickBtn);
            btnWrap.appendChild(btn);

            row.appendChild(nameEl);
            row.appendChild(metaEl);
            row.appendChild(statusEl);
            row.appendChild(btnWrap);
            listEl.appendChild(row);
        });

        const transferredCount = recordings.filter(r => r.transfer_status === 'completed').length;
        const inProgressCount = recordings.filter(r => r.transfer_status === 'in_progress').length;
        let statusParts = [`${recordings.length} recording(s) in slot ${slotId}`];
        if (transferredCount > 0) statusParts.push(`${transferredCount} transferred`);
        if (inProgressCount > 0) statusParts.push(`${inProgressCount} active`);
        statusEl.innerText = statusParts.join(' · ');
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
            showToast(`Play failed on ${host}: ${data.detail || 'Unknown error'}`, 'error');
            return;
        }
        updateDashboardMetrics();
    } catch (_) {
        showToast(`Play failed on ${host}: Could not reach backend API.`, 'error');
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
    switchAppTab,
    wpStartAll,
    wpStopAll,
    wpStreamStart,
    wpStreamStop,
    openWpPresenterModal,
    wpRemovePresenter,
    wpDiscover,
    wpOpenSettings,
    wpFetchKeys,
    wpStageEvent,
    wpAddEvent,
    wpSaveSchedule,
    wpFilterSchedule,
    wpLoadActiveToForm,
    wpSaveStreamConfig,
    wpPushToTarget,
    wpApplyConfigToAllEvents,
    wpApplyProfileToAllEvents,
    wpOnPushTargetChanged,
    wpOnProtocolChanged,
    wpSaveAsProfile,
    wpEditProfile,
    wpApplyProfile,
    wpDeleteProfile,
    wpTriggerPluginSync,
    wpUploadScheduleFile,
    wpClearActiveEvent,
    closeWpPresenterModal,
    saveWpPresenter,
    closeWpSettings,
    closeGuideModal,
});

// Update your primary load sequence to populate the HUD card on application bootup
async function loadPluginManagerSystem() {
    try {
        const pluginRes = await fetch(HD_API_BASE + '/api/plugins');
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
        if (scheduleContainer && !scheduleContainer.dataset.bound) {
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

        // Also bind auto-save to WP schedule matrix
        const wpScheduleContainer = document.getElementById('wp-schedule-matrix');
        if (wpScheduleContainer && !wpScheduleContainer.dataset.bound) {
            wpScheduleContainer.addEventListener('input', (event) => {
                const target = event.target;
                if (!(target instanceof HTMLElement)) return;
                if (target.closest('.schedule-row-item')) {
                    if (target.classList.contains('sch-date') || target.classList.contains('sch-time')) {
                        return;
                    }
                    mergeVisibleRowsIntoCache();
                    requestWpScheduleSaveDebounced();
                }
            });
            wpScheduleContainer.addEventListener('change', (event) => {
                const target = event.target;
                if (!(target instanceof HTMLElement)) return;
                if (target.closest('.schedule-row-item')) {
                    mergeVisibleRowsIntoCache();
                    requestWpScheduleSaveDebounced();
                }
            });
            wpScheduleContainer.dataset.bound = 'true';
        }

        // Pull active server token state and force updates to HUD card
        const activeContextRes = await fetch(HD_API_BASE + '/api/schedule/active');
        const activeContext = await activeContextRes.json();
        globallyActiveEventId = activeContext.id;
        updateLiveStagingHUD(activeContext.id, activeContext.planned_title);

        const dataRes = await fetch(HD_API_BASE + '/api/schedule');
        const schedule = await dataRes.json();
        renderScheduleMatrix(schedule);
    } catch(e) { console.error("Could not synchronize core schedule interface modules: ", e); }
}

// Application execution setups
pullConfigurationMatrix();
let _dashboardPollInterval = null;
let _eventSource = null;

function _startSSE() {
    if (_eventSource) return;
    _eventSource = new EventSource(HD_API_BASE + '/api/events');
    _eventSource.onmessage = (event) => {
        try {
            const state = JSON.parse(event.data);
            _updateDashboardFromState(state);
        } catch (_) {}
    };
    _eventSource.onerror = () => {
        _eventSource.close();
        _eventSource = null;
        _startDashboardPolling();
    };
}

function _startDashboardPolling() {
    if (_dashboardPollInterval) return;
    _dashboardPollInterval = setInterval(updateDashboardMetrics, 2000);
}
function _stopDashboardPolling() {
    if (_dashboardPollInterval) { clearInterval(_dashboardPollInterval); _dashboardPollInterval = null; }
}
document.addEventListener('visibilitychange', () => {
    if (document.hidden) { _stopDashboardPolling(); if (_eventSource) { _eventSource.close(); _eventSource = null; } }
    else { if (navigator.onLine) _startSSE(); else _startDashboardPolling(); updateDashboardMetrics(); }
});
_startSSE();
updateDashboardMetrics();
loadPluginManagerSystem();

// --- Keyboard Shortcuts ---
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'r') { e.preventDefault(); sendCommandToAll('record'); }
    else if ((e.ctrlKey || e.metaKey) && e.key === '.') { e.preventDefault(); sendCommandToAll('stop'); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveScheduleFromMatrix(); }
    else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'S') { e.preventDefault(); saveConfigToServer(); }
});

// --- Schedule Drag and Drop ---
let _draggedRow = null;
let _draggedRowKey = null;

document.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.schedule-row-item');
    if (!row) return;
    _draggedRow = row;
    _draggedRowKey = row.dataset.rowKey;
    row.style.opacity = '0.4';
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.dataset.rowKey);
});

document.addEventListener('dragend', (e) => {
    const row = e.target.closest('.schedule-row-item');
    if (row) row.style.opacity = '';
    document.querySelectorAll('.schedule-row-item.drag-over').forEach(el => el.classList.remove('drag-over'));
    _draggedRow = null;
    _draggedRowKey = null;
});

document.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const row = e.target.closest('.schedule-row-item');
    if (row && row !== _draggedRow) {
        document.querySelectorAll('.schedule-row-item.drag-over').forEach(el => el.classList.remove('drag-over'));
        row.classList.add('drag-over');
    }
});

document.addEventListener('dragleave', (e) => {
    const row = e.target.closest('.schedule-row-item');
    if (row) row.classList.remove('drag-over');
});

document.addEventListener('drop', (e) => {
    e.preventDefault();
    const targetRow = e.target.closest('.schedule-row-item');
    if (!targetRow || !_draggedRow || targetRow === _draggedRow) return;
    targetRow.classList.remove('drag-over');

    const sourceKey = _draggedRowKey;
    const targetKey = targetRow.dataset.rowKey;
    const sourceIdx = scheduleDataCache.findIndex(item => (item._row_key || scheduleItemKey(item)) === decodeURIComponent(sourceKey));
    const targetIdx = scheduleDataCache.findIndex(item => (item._row_key || scheduleItemKey(item)) === decodeURIComponent(targetKey));
    if (sourceIdx === -1 || targetIdx === -1) return;

    const [moved] = scheduleDataCache.splice(sourceIdx, 1);
    scheduleDataCache.splice(targetIdx, 0, moved);
    renderScheduleMatrix(scheduleDataCache, true);
    saveScheduleFromMatrix();
});

// ==================== WEB PRESENTER FUNCTIONS ====================

function switchAppTab(tab) {
    activeTab = tab;
    localStorage.setItem('activeTab', tab);
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.getElementById(`tab-${tab}`).classList.add('active');
    document.getElementById(`panel-${tab}`).classList.add('active');

    const title = document.getElementById('app-title');
    const subtitle = document.getElementById('app-subtitle');
    const hdControls = document.getElementById('hd-header-controls');
    const wpControls = document.getElementById('wp-header-controls');

    // Toggle stream settings visibility in schedule rows
    document.querySelectorAll('.schedule-row-item .wp-stream-toggle').forEach(el => {
        el.style.display = tab === 'hyperdeck' ? 'none' : '';
    });

    if (tab === 'webpresenter') {
        if (title) title.textContent = 'Web Presenter Control Center';
        if (subtitle) subtitle.textContent = 'Live streaming management for Blackmagic Web Presenters.';
        if (hdControls) hdControls.classList.add('hidden');
        if (wpControls) { wpControls.classList.remove('hidden'); wpControls.classList.add('flex'); }
        loadWpPresenters();
        wpLoadActiveToForm();
        loadWpKeyPlugins();
        loadWpSchedule();
        loadWpProfiles();
        wpLoadPluginSelector();
        wpLoadApplyProfileSelect();
        wpUpdateStagedEventHud();
        startWpSse();
        // Setup push target change handler
        const pushTarget = document.getElementById('wp-push-target');
        if (pushTarget && !pushTarget.dataset.bound) {
            pushTarget.addEventListener('change', wpOnPushTargetChanged);
            pushTarget.dataset.bound = 'true';
        }
    } else {
        if (title) title.textContent = 'HyperDeck Automation Center';
        if (subtitle) subtitle.textContent = 'Automated multi-device media capture system.';
        if (hdControls) { hdControls.classList.remove('hidden'); hdControls.classList.add('flex'); }
        if (wpControls) wpControls.classList.add('hidden');
        stopWpSse();
    }
}

// --- WP SSE ---
function startWpSse() {
    if (wpSseSource) return;
    if (wpPollInterval) { clearInterval(wpPollInterval); wpPollInterval = null; }
    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/events` : '/api/wp/events';
    try {
        wpSseSource = new EventSource(url);
        wpSseSource.onmessage = (event) => {
            wpStateCache = JSON.parse(event.data);
            renderWpPresenterCards();
            updateWpGlobalStatus();
        };
        wpSseSource.onerror = () => {
            wpSseSource.close();
            wpSseSource = null;
            // Fall back to polling and periodically retry SSE
            wpPollInterval = setInterval(() => {
                if (!document.getElementById('panel-webpresenter')?.classList.contains('active')) return;
                loadWpState();
                // Try to reconnect SSE every 10 seconds
                if (!wpSseSource) startWpSse();
            }, 3000);
        };
    } catch (_) {}
}

function stopWpSse() {
    if (wpSseSource) { wpSseSource.close(); wpSseSource = null; }
    if (wpPollInterval) { clearInterval(wpPollInterval); wpPollInterval = null; }
}

async function loadWpState() {
    try {
        const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/state` : '/api/wp/state';
        const res = await fetch(url);
        wpStateCache = await res.json();
        renderWpPresenterCards();
        updateWpGlobalStatus();
    } catch (_) {}
}

// --- WP Presenter Management ---
async function loadWpPresenters() {
    try {
        const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/presenters` : '/api/wp/presenters';
        const res = await fetch(url);
        const data = await res.json();
        wpPresentersConfig = {};
        (data.presenters || []).forEach(p => { wpPresentersConfig[p.name] = p; });
        renderWpPresenterCards();
    } catch (_) {}
}

function renderWpPresenterCards() {
    const container = document.getElementById('wp-presenters-container');
    if (!container) return;
    const names = Object.keys(wpPresentersConfig);
    if (names.length === 0) {
        container.innerHTML = '<div class="text-[11px] text-slate-500 px-2 py-4">No Web Presenters configured. Click "+ Add" to get started.</div>';
        return;
    }

    // Get staged event info
    const activeEvent = typeof globallyActiveEventId !== 'undefined' && globallyActiveEventId && globallyActiveEventId !== 'default'
        ? scheduleDataCache.find(e => e.id === globallyActiveEventId) : null;
    const eventTitle = activeEvent ? (activeEvent.planned_title || activeEvent.id || '') : '';
    const eventPlatform = activeEvent ? (activeEvent.platform || '') : '';

    container.innerHTML = '';
    names.forEach(name => {
        const wp = wpPresentersConfig[name];
        const host = wp.host || '';
        const role = wp.role || '';
        const stage = wp.stage || '';
        const state = wpStateCache[host] || {};
        const connected = state.connected !== false;
        const streaming = state.streaming === true;
        const status = state.status || 'Unknown';
        const duration = state.duration || '';
        const bitrate = state.bitrate || '0';
        const cacheUsed = state.cache_used || 0;
        const devicePlatform = state.platform || '';
        const deviceUrl = state.streaming ? (state.platform || '') : '';

        const statusColor = streaming ? 'bg-emerald-500' : (connected ? 'bg-slate-500' : 'bg-rose-500');
        const cacheColor = cacheUsed > 80 ? 'bg-rose-500' : (cacheUsed > 30 ? 'bg-amber-500' : 'bg-emerald-500');

        const roleBadge = role === 'primary' ? '<span class="text-[9px] px-1.5 py-0.5 rounded bg-emerald-600/20 text-emerald-300 border border-emerald-500/30">PRIMARY</span>'
            : role === 'backup' ? '<span class="text-[9px] px-1.5 py-0.5 rounded bg-amber-600/20 text-amber-300 border border-amber-500/30">BACKUP</span>'
            : '';
        const stageBadge = stage ? `<span class="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">${escHtml(stage)}</span>` : '';

        // Event info line
        let eventInfoHtml = '';
        if (streaming && devicePlatform) {
            eventInfoHtml = `<div class="text-[11px] text-emerald-400 mb-2">LIVE: ${escHtml(devicePlatform)}</div>`;
        } else if (eventTitle) {
            const pushed = eventPlatform && devicePlatform && eventPlatform === devicePlatform;
            eventInfoHtml = `<div class="text-[11px] mb-2 ${pushed ? 'text-indigo-400' : 'text-slate-500'}">Next: <span class="text-white">${escHtml(eventTitle)}</span>${pushed ? ' <span class="text-[9px] px-1 py-0.5 rounded bg-indigo-600/20 text-indigo-300">CONFIGURED</span>' : ' <span class="text-[9px] px-1 py-0.5 rounded bg-amber-600/20 text-amber-300">NOT PUSHED</span>'}</div>`;
        }

        const card = document.createElement('div');
        card.className = 'rounded-lg border border-slate-800 bg-slate-900 p-4';
        card.innerHTML = `
            <div class="flex items-center justify-between mb-3">
                <div class="flex items-center gap-2 flex-wrap">
                    <span class="flex h-2.5 w-2.5 rounded-full ${statusColor}"></span>
                    <span class="text-sm font-medium text-white">${escHtml(name)}</span>
                    ${roleBadge}
                    ${stageBadge}
                    <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">${escHtml(status)}</span>
                </div>
                <div class="flex gap-1">
                    <button onclick="openWpPresenterModal('${escAttr(name)}')" class="text-[10px] bg-slate-800 text-slate-300 border border-slate-700 rounded px-2 py-1 hover:bg-slate-700 transition cursor-pointer">Edit</button>
                    <button onclick="wpOpenSettings('${escAttr(host)}')" class="text-[10px] bg-slate-800 text-slate-300 border border-slate-700 rounded px-2 py-1 hover:bg-slate-700 transition cursor-pointer">Config</button>
                    <button onclick="wpRemovePresenter('${escAttr(name)}')" class="text-[10px] bg-rose-600/20 text-rose-300 border border-rose-500/30 rounded px-2 py-1 hover:bg-rose-600 transition cursor-pointer">Del</button>
                </div>
            </div>
            ${eventInfoHtml}
            <div class="grid grid-cols-2 gap-2 text-[11px] mb-3">
                <div><span class="text-slate-500">Duration:</span> <span class="text-white">${escHtml(duration)}</span></div>
                <div><span class="text-slate-500">Bitrate:</span> <span class="text-white">${escHtml(bitrate)} bps</span></div>
                <div class="col-span-2">
                    <span class="text-slate-500">Cache:</span>
                    <div class="wp-cache-bar mt-1 inline-block w-24 align-middle ml-1">
                        <div class="wp-cache-fill ${cacheColor}" style="width:${cacheUsed}%"></div>
                    </div>
                    <span class="text-white ml-1">${cacheUsed}%</span>
                </div>
            </div>
            <div class="flex gap-2">
                <button onclick="wpStreamStart('${escAttr(host)}')" ${streaming ? 'disabled' : ''} class="flex-1 text-[10px] ${streaming ? 'bg-slate-800 text-slate-600 cursor-not-allowed' : 'bg-red-600/20 text-red-300 border border-red-500/30 hover:bg-red-600 hover:text-white'} rounded px-2 py-1.5 transition cursor-pointer">▶ Stream</button>
                <button onclick="wpStreamStop('${escAttr(host)}')" ${!streaming ? 'disabled' : ''} class="flex-1 text-[10px] ${!streaming ? 'bg-slate-800 text-slate-600 cursor-not-allowed' : 'bg-red-600/20 text-red-300 border border-red-500/30 hover:bg-red-600 hover:text-white'} rounded px-2 py-1.5 transition cursor-pointer">■ End</button>
            </div>
        `;
        container.appendChild(card);
    });
}

function updateWpGlobalStatus() {
    const el = document.getElementById('wp-global-status');
    if (!el) return;
    const states = Object.values(wpStateCache);
    if (states.length === 0) {
        el.innerHTML = '<span class="flex h-2.5 w-2.5 rounded-full bg-slate-500"></span><span class="text-slate-400">No devices</span>';
        return;
    }
    const allConnected = states.every(s => s.connected !== false);
    const anyStreaming = states.some(s => s.streaming === true);
    const anyHighCache = states.some(s => (s.cache_used || 0) > 30);

    if (!allConnected) {
        el.innerHTML = '<span class="flex h-2.5 w-2.5 rounded-full bg-rose-500"></span><span class="text-rose-400">Some devices offline</span>';
    } else if (anyHighCache) {
        el.innerHTML = '<span class="flex h-2.5 w-2.5 rounded-full bg-amber-500 animate-pulse"></span><span class="text-amber-400">Buffer building</span>';
    } else if (anyStreaming) {
        el.innerHTML = '<span class="flex h-2.5 w-2.5 rounded-full bg-emerald-500"></span><span class="text-emerald-400">All healthy — streaming</span>';
    } else {
        el.innerHTML = '<span class="flex h-2.5 w-2.5 rounded-full bg-emerald-500"></span><span class="text-emerald-400">All healthy</span>';
    }
}

// --- WP Stream Control ---
async function wpStreamStart(host) {
    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/stream/start` : '/api/wp/stream/start';
    try {
        await fetch(url, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({hosts: [host]}) });
        setTimeout(loadWpState, 500);
    } catch (_) { showToast('Failed to start stream', 'error'); }
}

async function wpStreamStop(host) {
    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/stream/stop` : '/api/wp/stream/stop';
    try {
        await fetch(url, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({hosts: [host]}) });
        setTimeout(loadWpState, 500);
    } catch (_) { showToast('Failed to stop stream', 'error'); }
}

async function wpStartAll() {
    if (!confirm('Start streaming on ALL Web Presenters?')) return;
    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/stream/start-all` : '/api/wp/stream/start-all';
    try {
        await fetch(url, { method: 'POST' });
        setTimeout(loadWpState, 500);
    } catch (_) { showToast('Failed to start streams', 'error'); }
}

async function wpStopAll() {
    if (!confirm('Stop streaming on ALL Web Presenters?')) return;
    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/stream/stop-all` : '/api/wp/stream/stop-all';
    try {
        await fetch(url, { method: 'POST' });
        setTimeout(loadWpState, 500);
    } catch (_) { showToast('Failed to stop streams', 'error'); }
}

// --- WP Presenter Config ---
function openWpPresenterModal(editName) {
    const modal = document.getElementById('wp-presenter-modal');
    const title = document.getElementById('wp-presenter-modal-title');
    const editNameInput = document.getElementById('wp-presenter-edit-name');
    const nameInput = document.getElementById('wp-presenter-name');
    const hostInput = document.getElementById('wp-presenter-host');
    const portInput = document.getElementById('wp-presenter-port');
    const roleInput = document.getElementById('wp-presenter-role');
    const stageInput = document.getElementById('wp-presenter-stage');

    if (editName) {
        title.textContent = 'Edit Web Presenter';
        editNameInput.value = editName;
        nameInput.value = editName;
        const wp = wpPresentersConfig[editName] || {};
        hostInput.value = wp.host || '';
        portInput.value = wp.port || 9977;
        roleInput.value = wp.role || '';
        stageInput.value = wp.stage || '';
    } else {
        title.textContent = 'Add Web Presenter';
        editNameInput.value = '';
        nameInput.value = '';
        hostInput.value = '';
        portInput.value = 9977;
        roleInput.value = '';
        stageInput.value = '';
    }

    // Populate stage datalist from schedule + presenters
    const stages = new Set();
    scheduleDataCache.forEach(e => { if (e.stage) stages.add(e.stage); });
    Object.values(wpPresentersConfig).forEach(p => { if (p.stage) stages.add(p.stage); });
    const datalist = document.getElementById('wp-stage-options');
    datalist.innerHTML = '';
    stages.forEach(s => { const opt = document.createElement('option'); opt.value = s; datalist.appendChild(opt); });

    modal.classList.remove('hidden');
}

function closeWpPresenterModal() {
    document.getElementById('wp-presenter-modal').classList.add('hidden');
}

async function saveWpPresenter() {
    const editName = document.getElementById('wp-presenter-edit-name').value;
    const name = document.getElementById('wp-presenter-name').value.trim();
    const host = document.getElementById('wp-presenter-host').value.trim();
    const port = parseInt(document.getElementById('wp-presenter-port').value || '9977', 10);
    const role = document.getElementById('wp-presenter-role').value;
    const stage = document.getElementById('wp-presenter-stage').value.trim();

    if (!name) { showToast('Enter a device name', 'warning'); return; }
    if (!host) { showToast('Enter an IP address', 'warning'); return; }

    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/presenters` : '/api/wp/presenters';
    try {
        await fetch(url, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name, host, port, role, stage}),
        });
        closeWpPresenterModal();
        loadWpPresenters();
        showToast(editName ? 'Presenter updated' : 'Presenter added', 'success');
    } catch (_) { showToast('Failed to save presenter', 'error'); }
}

async function wpRemovePresenter(name) {
    if (!confirm(`Remove presenter "${name}"?`)) return;
    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/presenters/${encodeURIComponent(name)}` : `/api/wp/presenters/${encodeURIComponent(name)}`;
    try {
        await fetch(url, { method: 'DELETE' });
        loadWpPresenters();
        showToast('Presenter removed', 'success');
    } catch (_) { showToast('Failed to remove presenter', 'error'); }
}

async function wpDiscover() {
    showToast('Scanning network for Web Presenters...', 'info');
    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/discover` : '/api/wp/discover';
    try {
        const res = await fetch(url);
        const data = await res.json();
        const found = data.found || [];
        const subnet = data.subnet || '';
        const scanned = data.scanned || 0;
        if (found.length === 0) {
            showToast(`No Web Presenters found in ${subnet} (${scanned} hosts scanned)`, 'info');
        } else {
            found.forEach(d => {
                const name = d.label || d.model || d.ip;
                if (!wpPresentersConfig[name]) {
                    const saveUrl = WP_API_BASE ? `${WP_API_BASE}/api/wp/presenters` : '/api/wp/presenters';
                    fetch(saveUrl, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({name, host: d.ip}),
                    });
                }
            });
            loadWpPresenters();
            showToast(`Found ${found.length} Web Presenter(s) in ${subnet}`, 'success');
        }
    } catch (_) { showToast('Discovery failed', 'error'); }
}

async function wpOpenSettings(host) {
    const modal = document.getElementById('wp-settings-modal');
    const hostLabel = document.getElementById('wp-settings-host');
    const content = document.getElementById('wp-settings-content');
    hostLabel.textContent = host;
    content.innerHTML = '<div class="text-slate-500">Loading settings...</div>';
    modal.classList.remove('hidden');

    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/${host}/settings` : `/api/wp/${host}/settings`;
    try {
        const res = await fetch(url);
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            content.innerHTML = `<div class="text-rose-400">${escHtml(data.detail || 'Failed to load settings')}</div>`;
            return;
        }
        const data = await res.json();
        const settings = data.settings || {};
        const identity = data.identity || {};
        let html = '';

        if (identity.Model) html += `<div class="flex justify-between"><span class="text-slate-500">Model</span><span class="text-white">${escHtml(identity.Model)}</span></div>`;
        if (identity.Label) html += `<div class="flex justify-between"><span class="text-slate-500">Label</span><span class="text-white">${escHtml(identity.Label)}</span></div>`;

        html += '<div class="border-t border-slate-800 my-2"></div>';

        const displayKeys = ['Video Mode', 'Current Platform', 'Current Server', 'Current Quality Level', 'Current URL'];
        displayKeys.forEach(key => {
            if (settings[key]) {
                html += `<div class="flex justify-between"><span class="text-slate-500">${escHtml(key)}</span><span class="text-white">${escHtml(settings[key])}</span></div>`;
            }
        });

        const listKeys = ['Available Video Modes', 'Available Default Platforms', 'Available Quality Levels'];
        listKeys.forEach(key => {
            if (settings[key]) {
                const items = settings[key].split(',').map(s => s.trim());
                html += `<div class="mt-2"><span class="text-slate-500 block mb-1">${escHtml(key)}</span><div class="flex flex-wrap gap-1">`;
                items.forEach(item => { html += `<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">${escHtml(item)}</span>`; });
                html += '</div></div>';
            }
        });

        content.innerHTML = html || '<div class="text-slate-500">No settings data returned.</div>';
    } catch (_) {
        content.innerHTML = '<div class="text-rose-400">Could not reach device.</div>';
    }
}

function closeWpSettings() {
    document.getElementById('wp-settings-modal').classList.add('hidden');
}

// --- Stream Platform URL Presets ---
const STREAM_PLATFORM_PRESETS = {
    'YouTube': {
        primary: 'rtmp://a.rtmp.youtube.com/live2',
        backup: 'rtmp://b.rtmp.youtube.com/live2',
    },
    'Twitch': {
        primary: 'rtmp://live.twitch.tv/app',
        backup: 'rtmp://live-backup.twitch.tv/app',
    },
    'Facebook': {
        primary: 'rtmps://live-api-s.facebook.com:443/rtmp',
        backup: '',
    },
    'Restream.IO': {
        primary: 'rtmp://live.restream.io/live',
        backup: 'rtmp://live-2.restream.io/live',
    },
};

// --- Pending Changes Queue for Streaming Devices ---
let pendingChangesQueue = {};  // host -> settings to apply after stream ends

function wpQueueChangeForHost(host, settings) {
    pendingChangesQueue[host] = settings;
}

function wpApplyPendingChanges() {
    Object.entries(pendingChangesQueue).forEach(([host, settings]) => {
        const state = wpStateCache[host] || {};
        if (!state.streaming) {
            const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/${host}/settings` : `/api/wp/${host}/settings`;
            fetch(url, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(settings),
            }).then(res => {
                if (res.ok) {
                    delete pendingChangesQueue[host];
                    showToast(`Settings applied to ${host}`, 'success');
                }
            }).catch(() => {
                // Keep in queue for retry on next cycle
            });
        }
    });
}

// Check for pending changes every 5 seconds
setInterval(wpApplyPendingChanges, 5000);

function wpApplyPlatformPreset() {
    const platform = document.getElementById('wp-cfg-platform').value;
    const preset = STREAM_PLATFORM_PRESETS[platform];
    if (!preset) {
        showToast('No URL preset available for this platform. Enter URLs manually.', 'info');
        return;
    }
    const primaryUrl = document.getElementById('wp-cfg-primary-url');
    const backupUrl = document.getElementById('wp-cfg-backup-url');
    if (primaryUrl && preset.primary) primaryUrl.value = preset.primary;
    if (backupUrl && preset.backup) backupUrl.value = preset.backup;
    const s = document.getElementById('wp-cfg-status');
    if (s) { s.textContent = `Applied ${platform} URL preset`; s.className = 'text-[10px] text-emerald-400 mt-2'; }
}

// --- Profile Selection & Field Locking ---
let activeProfileName = '';

function wpOnProfileSelected() {
    const select = document.getElementById('wp-cfg-profile');
    const profileName = select?.value || '';
    const editBtn = document.getElementById('btn-wp-edit-profile');
    const detachBtn = document.getElementById('btn-wp-detach-profile');

    if (!profileName) {
        wpUnlockFormFields();
        if (editBtn) editBtn.disabled = true;
        if (detachBtn) detachBtn.disabled = true;
        activeProfileName = '';
        return;
    }

    // Load profile and fill form
    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/profiles` : '/api/wp/profiles';
    fetch(url).then(r => r.json()).then(profiles => {
        const profile = profiles.find(p => p.name === profileName);
        if (!profile || !profile.settings) return;
        const s = profile.settings;
        document.getElementById('wp-cfg-title').value = s.title || '';
        document.getElementById('wp-cfg-platform').value = s.platform || 'Custom';
        document.getElementById('wp-cfg-quality').value = s.quality || 'Streaming Medium';
        document.getElementById('wp-cfg-video-mode').value = s.video_mode || 'Auto';
        document.getElementById('wp-cfg-protocol').value = s.protocol || 'rtmp';
        wpOnProtocolChanged();

        if (s.protocol === 'srt') {
            document.getElementById('wp-cfg-srt-primary').value = s.srt_primary || '';
            document.getElementById('wp-cfg-srt-passphrase').value = s.srt_passphrase || '';
            document.getElementById('wp-cfg-srt-backup').value = s.srt_backup || '';
            document.getElementById('wp-cfg-srt-backup-passphrase').value = s.srt_backup_passphrase || '';
        } else {
            document.getElementById('wp-cfg-primary-url').value = s.primary_url || '';
            document.getElementById('wp-cfg-primary-key').value = s.primary_key || '';
            document.getElementById('wp-cfg-backup-url').value = s.backup_url || '';
            document.getElementById('wp-cfg-backup-key').value = s.backup_key || '';
        }

        wpLockFormFields();
        activeProfileName = profileName;
        if (editBtn) editBtn.disabled = false;
        if (detachBtn) detachBtn.disabled = false;
        const status = document.getElementById('wp-cfg-status');
        if (status) { status.textContent = `Loaded profile: ${profileName}`; status.className = 'text-[10px] text-indigo-400 mt-2'; }
    }).catch(() => {});
}

function wpLockFormFields() {
    const fields = document.querySelectorAll('#wp-cfg-protocol, #wp-cfg-platform, #wp-cfg-quality, #wp-cfg-video-mode, #wp-cfg-primary-url, #wp-cfg-primary-key, #wp-cfg-backup-url, #wp-cfg-backup-key, #wp-cfg-srt-primary, #wp-cfg-srt-passphrase, #wp-cfg-srt-backup, #wp-cfg-srt-backup-passphrase');
    fields.forEach(f => { f.disabled = true; f.classList.add('opacity-60'); });
}

function wpUnlockFormFields() {
    const fields = document.querySelectorAll('#wp-cfg-protocol, #wp-cfg-platform, #wp-cfg-quality, #wp-cfg-video-mode, #wp-cfg-primary-url, #wp-cfg-primary-key, #wp-cfg-backup-url, #wp-cfg-backup-key, #wp-cfg-srt-primary, #wp-cfg-srt-passphrase, #wp-cfg-srt-backup, #wp-cfg-srt-backup-passphrase');
    fields.forEach(f => { f.disabled = false; f.classList.remove('opacity-60'); });
}

function wpDetachProfile() {
    wpUnlockFormFields();
    activeProfileName = '';
    const select = document.getElementById('wp-cfg-profile');
    if (select) select.value = '';
    const editBtn = document.getElementById('btn-wp-edit-profile');
    const detachBtn = document.getElementById('btn-wp-detach-profile');
    if (editBtn) editBtn.disabled = true;
    if (detachBtn) detachBtn.disabled = true;
    const status = document.getElementById('wp-cfg-status');
    if (status) { status.textContent = 'Fields unlocked — editing manually'; status.className = 'text-[10px] text-slate-400 mt-2'; }
}
function wpOnProtocolChanged() {
    const protocol = document.getElementById('wp-cfg-protocol').value;
    const rtmpFields = document.getElementById('wp-cfg-rtmp-fields');
    const srtFields = document.getElementById('wp-cfg-srt-fields');
    if (protocol === 'srt') {
        rtmpFields.classList.add('hidden');
        srtFields.classList.remove('hidden');
    } else {
        rtmpFields.classList.remove('hidden');
        srtFields.classList.add('hidden');
    }
}

async function wpLoadActiveToForm() {
    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/active` : '/api/wp/active';
    try {
        const res = await fetch(url);
        const data = await res.json();
        document.getElementById('wp-cfg-title').value = data.title || data.event_id || '';
        document.getElementById('wp-cfg-platform').value = data.platform || 'Custom';
        document.getElementById('wp-cfg-quality').value = data.quality || 'Streaming Medium';
        document.getElementById('wp-cfg-video-mode').value = data.video_mode || 'Auto';

        const protocol = data.protocol || 'rtmp';
        document.getElementById('wp-cfg-protocol').value = protocol;
        wpOnProtocolChanged();

        if (protocol === 'srt') {
            document.getElementById('wp-cfg-srt-primary').value = data.srt_primary || '';
            document.getElementById('wp-cfg-srt-passphrase').value = data.srt_passphrase || '';
            document.getElementById('wp-cfg-srt-backup').value = data.srt_backup || '';
            document.getElementById('wp-cfg-srt-backup-passphrase').value = data.srt_backup_passphrase || '';
        } else {
            document.getElementById('wp-cfg-primary-url').value = data.primary_url || '';
            document.getElementById('wp-cfg-primary-key').value = data.primary_key || '';
            document.getElementById('wp-cfg-backup-url').value = data.backup_url || '';
            document.getElementById('wp-cfg-backup-key').value = data.backup_key || '';
        }

        // Set profile selector if event has a linked profile
        const profileSelect = document.getElementById('wp-cfg-profile');
        if (profileSelect && data.stream_profile) {
            profileSelect.value = data.stream_profile;
            wpOnProfileSelected();
        } else {
            wpUnlockFormFields();
            if (profileSelect) profileSelect.value = '';
        }

        const s = document.getElementById('wp-cfg-status');
        if (s) { s.textContent = 'Loaded active config'; s.className = 'text-[10px] text-emerald-400 mt-2'; }
    } catch (_) {
        const s = document.getElementById('wp-cfg-status');
        if (s) { s.textContent = 'Failed to load config'; s.className = 'text-[10px] text-rose-400 mt-2'; }
    }
}

function wpCollectStreamConfig() {
    const protocol = document.getElementById('wp-cfg-protocol').value;
    const config = {
        title: document.getElementById('wp-cfg-title').value.trim(),
        platform: document.getElementById('wp-cfg-platform').value,
        quality: document.getElementById('wp-cfg-quality').value,
        video_mode: document.getElementById('wp-cfg-video-mode').value,
        protocol: protocol,
    };

    if (protocol === 'srt') {
        config.srt_primary = document.getElementById('wp-cfg-srt-primary').value.trim();
        config.srt_passphrase = document.getElementById('wp-cfg-srt-passphrase').value.trim();
        config.srt_backup = document.getElementById('wp-cfg-srt-backup').value.trim();
        config.srt_backup_passphrase = document.getElementById('wp-cfg-srt-backup-passphrase').value.trim();
    } else {
        config.primary_url = document.getElementById('wp-cfg-primary-url').value.trim();
        config.primary_key = document.getElementById('wp-cfg-primary-key').value.trim();
        config.backup_url = document.getElementById('wp-cfg-backup-url').value.trim();
        config.backup_key = document.getElementById('wp-cfg-backup-key').value.trim();
    }
    return config;
}

async function wpSaveStreamConfig() {
    const config = wpCollectStreamConfig();
    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/active` : '/api/wp/active';
    try {
        await fetch(url, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(config),
        });
        const s = document.getElementById('wp-cfg-status');
        if (s) { s.textContent = 'Saved'; s.className = 'text-[10px] text-emerald-400 mt-2'; }
        showToast('Stream configuration saved', 'success');
    } catch (_) {
        const s = document.getElementById('wp-cfg-status');
        if (s) { s.textContent = 'Save failed'; s.className = 'text-[10px] text-rose-400 mt-2'; }
    }
}

function wpCollectStreamSettings() {
    const protocol = document.getElementById('wp-cfg-protocol').value;
    const settings = {};
    const platform = document.getElementById('wp-cfg-platform').value;
    const quality = document.getElementById('wp-cfg-quality').value;
    const videoMode = document.getElementById('wp-cfg-video-mode').value;

    if (videoMode) settings['Video Mode'] = videoMode;
    if (platform) settings['Current Platform'] = platform;
    if (quality) settings['Current Quality Level'] = quality;

    if (protocol === 'srt') {
        const srtPrimary = document.getElementById('wp-cfg-srt-primary').value.trim();
        const srtPassphrase = document.getElementById('wp-cfg-srt-passphrase').value.trim();
        if (srtPrimary) settings['Current URL'] = srtPrimary;
        if (srtPassphrase) settings['Password'] = srtPassphrase;
        settings['Current Server'] = 'Custom';
        settings['Current Platform'] = 'Custom URL H.264';
    } else {
        if (platform === 'Custom' || platform === 'Custom URL H.264') {
            settings['Current Server'] = 'Custom';
            const primaryUrl = document.getElementById('wp-cfg-primary-url').value.trim();
            if (primaryUrl) settings['Current URL'] = primaryUrl;
        } else {
            settings['Current Server'] = 'Primary';
        }
        const primaryKey = document.getElementById('wp-cfg-primary-key').value.trim();
        if (primaryKey) settings['Stream Key'] = primaryKey;
    }

    return settings;
}

function setTextIfExists(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

// --- Stream Profiles ---
async function loadWpProfiles() {
    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/profiles` : '/api/wp/profiles';
    try {
        const res = await fetch(url);
        const profiles = await res.json();

        // Update profiles container
        const container = document.getElementById('wp-profiles-container');
        if (container) {
            if (!Array.isArray(profiles) || profiles.length === 0) {
                container.innerHTML = '<div class="text-slate-500">No profiles saved.</div>';
            } else {
                container.innerHTML = '';
                profiles.forEach(p => {
                    const row = document.createElement('div');
                    row.className = 'flex items-center justify-between px-2 py-1.5 rounded hover:bg-slate-800 transition';
                    const s = p.settings || {};
                    const desc = [s.platform, s.quality, s.video_mode, s.protocol || 'rtmp'].filter(Boolean).join(' · ');
                    row.innerHTML = `
                        <div class="flex-1 min-w-0">
                            <span class="text-white">${escHtml(p.name)}</span>
                            <span class="text-[10px] text-slate-500 ml-2">${escHtml(desc)}</span>
                        </div>
                        <div class="flex gap-1 ml-2 shrink-0">
                            <button onclick="wpApplyProfile('${escAttr(p.name)}')" class="text-[10px] bg-indigo-600/20 text-indigo-300 border border-indigo-500/30 rounded px-2 py-1 hover:bg-indigo-600 hover:text-white transition cursor-pointer">Apply</button>
                            <button onclick="wpEditProfile('${escAttr(p.name)}')" class="text-[10px] bg-slate-800 text-slate-300 border border-slate-700 rounded px-2 py-1 hover:bg-slate-700 hover:text-white transition cursor-pointer">Edit</button>
                            <button onclick="wpDeleteProfile('${escAttr(p.name)}')" class="text-[10px] bg-rose-600/20 text-rose-300 border border-rose-500/30 rounded px-2 py-1 hover:bg-rose-600 hover:text-white transition cursor-pointer">Del</button>
                        </div>
                    `;
                    container.appendChild(row);
                });
            }
        }

        // Update config profile selector
        const configSelect = document.getElementById('wp-cfg-profile');
        if (configSelect) {
            const currentVal = configSelect.value;
            configSelect.innerHTML = '<option value="">None (manual)</option>';
            (Array.isArray(profiles) ? profiles : []).forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.name;
                opt.textContent = p.name;
                configSelect.appendChild(opt);
            });
            configSelect.value = currentVal;
        }
    } catch (_) {}
}

async function wpSaveAsProfile(updateName) {
    const name = updateName || prompt('Profile name:');
    if (!name) return;
    const config = wpCollectStreamConfig();
    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/profiles` : '/api/wp/profiles';
    try {
        await fetch(url, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name, settings: config}),
        });
        loadWpProfiles();
        wpRefreshAllProfileSelects();
        showToast(`Profile "${name}" ${updateName ? 'updated' : 'saved'}`, 'success');
    } catch (_) { showToast('Failed to save profile', 'error'); }
}

function wpEditProfile(name) {
    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/profiles` : '/api/wp/profiles';
    fetch(url).then(r => r.json()).then(profiles => {
        const profile = profiles.find(p => p.name === name);
        if (!profile || !profile.settings) { showToast('Profile not found', 'error'); return; }
        const s = profile.settings;
        document.getElementById('wp-cfg-title').value = s.title || '';
        document.getElementById('wp-cfg-platform').value = s.platform || 'Custom';
        document.getElementById('wp-cfg-quality').value = s.quality || 'Streaming Medium';
        document.getElementById('wp-cfg-video-mode').value = s.video_mode || 'Auto';
        document.getElementById('wp-cfg-protocol').value = s.protocol || 'rtmp';
        wpOnProtocolChanged();
        if (s.protocol === 'srt') {
            document.getElementById('wp-cfg-srt-primary').value = s.srt_primary || '';
            document.getElementById('wp-cfg-srt-passphrase').value = s.srt_passphrase || '';
            document.getElementById('wp-cfg-srt-backup').value = s.srt_backup || '';
            document.getElementById('wp-cfg-srt-backup-passphrase').value = s.srt_backup_passphrase || '';
        } else {
            document.getElementById('wp-cfg-primary-url').value = s.primary_url || '';
            document.getElementById('wp-cfg-primary-key').value = s.primary_key || '';
            document.getElementById('wp-cfg-backup-url').value = s.backup_url || '';
            document.getElementById('wp-cfg-backup-key').value = s.backup_key || '';
        }
        wpUnlockFormFields();
        activeProfileName = name;
        const select = document.getElementById('wp-cfg-profile');
        if (select) select.value = name;
        const editBtn = document.getElementById('btn-wp-edit-profile');
        const detachBtn = document.getElementById('btn-wp-detach-profile');
        if (editBtn) editBtn.disabled = false;
        if (detachBtn) detachBtn.disabled = false;
        const status = document.getElementById('wp-cfg-status');
        if (status) { status.textContent = `Editing: ${name} — modify and click Save to update`; status.className = 'text-[10px] text-amber-400 mt-2'; }
    }).catch(() => showToast('Failed to load profile', 'error'));
}

function wpEditCurrentProfile() {
    if (activeProfileName) wpEditProfile(activeProfileName);
}

async function wpApplyProfile(name) {
    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/profiles` : '/api/wp/profiles';
    try {
        const res = await fetch(url);
        const profiles = await res.json();
        const profile = profiles.find(p => p.name === name);
        if (!profile || !profile.settings) { showToast('Profile not found', 'error'); return; }
        const s = profile.settings;
        document.getElementById('wp-cfg-title').value = s.title || '';
        document.getElementById('wp-cfg-platform').value = s.platform || 'Custom';
        document.getElementById('wp-cfg-quality').value = s.quality || 'Streaming Medium';
        document.getElementById('wp-cfg-video-mode').value = s.video_mode || 'Auto';
        document.getElementById('wp-cfg-protocol').value = s.protocol || 'rtmp';
        wpOnProtocolChanged();

        if (s.protocol === 'srt') {
            document.getElementById('wp-cfg-srt-primary').value = s.srt_primary || '';
            document.getElementById('wp-cfg-srt-passphrase').value = s.srt_passphrase || '';
            document.getElementById('wp-cfg-srt-backup').value = s.srt_backup || '';
            document.getElementById('wp-cfg-srt-backup-passphrase').value = s.srt_backup_passphrase || '';
        } else {
            document.getElementById('wp-cfg-primary-url').value = s.primary_url || '';
            document.getElementById('wp-cfg-primary-key').value = s.primary_key || '';
            document.getElementById('wp-cfg-backup-url').value = s.backup_url || '';
            document.getElementById('wp-cfg-backup-key').value = s.backup_key || '';
        }
        showToast(`Profile "${name}" applied`, 'success');
    } catch (_) { showToast('Failed to load profile', 'error'); }
}

async function wpDeleteProfile(name) {
    if (!confirm(`Delete profile "${name}"?`)) return;
    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/profiles/${encodeURIComponent(name)}` : `/api/wp/profiles/${encodeURIComponent(name)}`;
    try {
        await fetch(url, {method: 'DELETE'});
        loadWpProfiles();
        wpRefreshAllProfileSelects();
        showToast(`Profile "${name}" deleted`, 'success');
    } catch (_) { showToast('Failed to delete profile', 'error'); }
}

// --- WP Key Plugins ---
async function loadWpKeyPlugins() {
    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/plugins/keys` : '/api/wp/plugins/keys';
    try {
        const res = await fetch(url);
        wpKeyPlugins = await res.json();
        const select = document.getElementById('wp-key-plugin-select');
        if (!select) return;
        select.innerHTML = '<option value="">Select a key provider...</option>';
        wpKeyPlugins.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.name;
            opt.textContent = p.label;
            select.appendChild(opt);
        });
        if (!select.dataset.bound) {
            select.addEventListener('change', () => {
                const ytConfig = document.getElementById('wp-youtube-config');
                if (ytConfig) ytConfig.classList.toggle('hidden', select.value !== 'youtube');
                if (select.value === 'youtube') loadYoutubeConfig();
            });
            select.dataset.bound = 'true';
        }
    } catch (_) {}
}

// --- Apply Settings to All Events ---
function wpLoadApplyProfileSelect() {
    const select = document.getElementById('wp-apply-profile-select');
    if (!select) return;
    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/profiles` : '/api/wp/profiles';
    fetch(url).then(r => r.json()).then(profiles => {
        select.innerHTML = '<option value="">Select a profile...</option>';
        (Array.isArray(profiles) ? profiles : []).forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.name;
            opt.textContent = p.name;
            select.appendChild(opt);
        });
    }).catch(() => {});
}

function wpApplyConfigToAllEvents() {
    const config = wpCollectStreamConfig();
    if (!confirm(`Apply current stream settings to ALL ${scheduleDataCache.length} events?`)) return;

    mergeVisibleRowsIntoCache();
        scheduleDataCache.forEach(item => {
            item.protocol = config.protocol || 'rtmp';
            item.quality = config.quality || '';
            item.video_mode = config.video_mode || '';
        if (config.protocol === 'srt') {
            item.primary_url = config.srt_primary || '';
            item.primary_key = config.srt_passphrase || '';
            item.backup_url = config.srt_backup || '';
            item.backup_key = config.srt_backup_passphrase || '';
        } else {
            item.primary_url = config.primary_url || '';
            item.primary_key = config.primary_key || '';
            item.backup_url = config.backup_url || '';
            item.backup_key = config.backup_key || '';
        }
    });
    wpSaveSchedule();
    showToast(`Applied settings to ${scheduleDataCache.length} events`, 'success');
}

function wpApplyProfileToAllEvents() {
    const select = document.getElementById('wp-apply-profile-select');
    const name = select?.value;
    if (!name) { showToast('Select a profile first', 'warning'); return; }

    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/profiles` : '/api/wp/profiles';
    fetch(url).then(r => r.json()).then(profiles => {
        const profile = profiles.find(p => p.name === name);
        if (!profile || !profile.settings) { showToast('Profile not found', 'error'); return; }
        if (!confirm(`Apply profile "${name}" to ALL ${scheduleDataCache.length} events?`)) return;
        mergeVisibleRowsIntoCache();
        const s = profile.settings;
        scheduleDataCache.forEach(item => {
            item.protocol = s.protocol || 'rtmp';
            item.quality = s.quality || '';
            item.video_mode = s.video_mode || '';
            if (s.protocol === 'srt') {
                item.primary_url = s.srt_primary || s.primary_url || '';
                item.primary_key = s.srt_passphrase || s.primary_key || '';
                item.backup_url = s.srt_backup || s.backup_url || '';
                item.backup_key = s.srt_backup_passphrase || s.backup_key || '';
            } else {
                item.primary_url = s.primary_url || '';
                item.primary_key = s.primary_key || '';
                item.backup_url = s.backup_url || '';
                item.backup_key = s.backup_key || '';
            }
            item.stream_profile = name;
        });
        wpSaveSchedule();
        showToast(`Applied profile "${name}" to ${scheduleDataCache.length} events`, 'success');
    }).catch(() => showToast('Failed to load profiles', 'error'));
}

// --- Schedule Row Stream Fields Toggle ---
function wpOnRowProtocolChanged(selectEl) {
    const row = selectEl.closest('.schedule-row-item');
    if (!row) return;
    const protocol = selectEl.value;
    const fields = row.querySelector('.sch-stream-fields');
    if (!fields) return;

    fields.querySelectorAll('label').forEach(label => {
        const input = label.querySelector('input, select');
        if (!input) return;
        const isRtmp = input.classList.contains('sch-primary-url') || input.classList.contains('sch-primary-key') ||
                        input.classList.contains('sch-backup-url') || input.classList.contains('sch-backup-key');
        const isSrt = input.classList.contains('sch-srt-primary') || input.classList.contains('sch-srt-passphrase') ||
                      input.classList.contains('sch-srt-backup') || input.classList.contains('sch-srt-backup-passphrase');
        if (isRtmp) {
            label.style.display = protocol === 'srt' ? 'none' : '';
            label.classList.toggle('hidden', protocol === 'srt');
        }
        if (isSrt) {
            label.style.display = protocol === 'rtmp' ? 'none' : '';
            label.classList.toggle('hidden', protocol === 'rtmp');
        }
    });
}

function wpOnRowProfileChanged(selectEl) {
    const row = selectEl.closest('.schedule-row-item');
    if (!row) return;
    const profileName = selectEl.value;
    const fields = row.querySelector('.sch-stream-fields');

    if (!profileName) {
        if (fields) {
            fields.querySelectorAll('input:not(.sch-stream-profile), select:not(.sch-stream-profile)').forEach(f => {
                f.disabled = false;
                f.classList.remove('opacity-60');
            });
        }
        return;
    }

    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/profiles` : '/api/wp/profiles';
    fetch(url).then(r => r.json()).then(profiles => {
        const profile = profiles.find(p => p.name === profileName);
        if (!profile || !profile.settings) return;
        const s = profile.settings;

        const setVal = (cls, val) => { const el = row.querySelector(cls); if (el) el.value = val || ''; };

        setVal('.sch-protocol', s.protocol || 'rtmp');
        setVal('.sch-quality', s.quality || '');
        setVal('.sch-video-mode', s.video_mode || '');
        setVal('.sch-primary-url', s.primary_url || '');
        setVal('.sch-primary-key', s.primary_key || '');
        setVal('.sch-backup-url', s.backup_url || '');
        setVal('.sch-backup-key', s.backup_key || '');

        // Toggle field visibility based on protocol
        const protocolSelect = row.querySelector('.sch-protocol');
        if (protocolSelect) wpOnRowProtocolChanged(protocolSelect);

        // Disable stream fields (not the profile dropdown itself)
        if (fields) {
            fields.querySelectorAll('input, select').forEach(f => {
                if (f.classList.contains('sch-stream-profile')) return;
                f.disabled = true;
                f.classList.add('opacity-60');
            });
        }
    }).catch(() => {});
}

// --- Bulk Stream Assignment ---
function wpOnPushTargetChanged() {
    const target = document.getElementById('wp-push-target').value;
    document.getElementById('wp-push-stage-row').classList.toggle('hidden', target !== 'stage');
    document.getElementById('wp-push-device-row').classList.toggle('hidden', target !== 'device');

    if (target === 'stage') {
        const stageSelect = document.getElementById('wp-push-stage');
        const stages = new Set(Object.values(wpPresentersConfig).map(p => p.stage).filter(Boolean));
        stageSelect.innerHTML = '<option value="">Select stage...</option>';
        stages.forEach(s => { const opt = document.createElement('option'); opt.value = s; opt.textContent = s; stageSelect.appendChild(opt); });
    }
    if (target === 'device') {
        const deviceSelect = document.getElementById('wp-push-device');
        deviceSelect.innerHTML = '<option value="">Select device...</option>';
        Object.keys(wpPresentersConfig).forEach(name => {
            const opt = document.createElement('option');
            opt.value = wpPresentersConfig[name].host;
            opt.textContent = name;
            deviceSelect.appendChild(opt);
        });
    }
}

async function wpPushToTarget() {
    const target = document.getElementById('wp-push-target').value;
    const config = wpCollectStreamConfig();
    if (Object.keys(config).length === 0) { showToast('Configure stream settings first', 'warning'); return; }

    let devices = [];
    if (target === 'all') {
        devices = Object.values(wpPresentersConfig).filter(p => p.host);
    } else if (target === 'primary') {
        devices = Object.values(wpPresentersConfig).filter(p => p.role === 'primary' && p.host);
    } else if (target === 'backup') {
        devices = Object.values(wpPresentersConfig).filter(p => p.role === 'backup' && p.host);
    } else if (target === 'stage') {
        const stage = document.getElementById('wp-push-stage').value;
        if (!stage) { showToast('Select a stage', 'warning'); return; }
        devices = Object.values(wpPresentersConfig).filter(p => p.stage === stage && p.host);
    } else if (target === 'device') {
        const host = document.getElementById('wp-push-device').value;
        if (!host) { showToast('Select a device', 'warning'); return; }
        devices = Object.values(wpPresentersConfig).filter(p => p.host === host);
    }

    if (devices.length === 0) { showToast('No devices match the selected target', 'warning'); return; }
    if (!confirm(`Push settings to ${devices.length} device(s)?`)) return;

    let successCount = 0;
    let queuedCount = 0;
    for (const device of devices) {
        const settings = {};
        if (config.video_mode) settings['Video Mode'] = config.video_mode;
        if (config.platform) settings['Current Platform'] = config.platform;
        if (config.quality) settings['Current Quality Level'] = config.quality;

        if (config.protocol === 'srt') {
            settings['Current Server'] = 'Custom';
            settings['Current Platform'] = 'Custom URL H.264';
            if (config.srt_primary) settings['Current URL'] = config.srt_primary;
            if (config.srt_passphrase) settings['Password'] = config.srt_passphrase;
        } else {
            if (device.role === 'backup') {
                if (config.platform === 'Custom' || config.platform === 'Custom URL H.264') {
                    settings['Current Server'] = 'Custom';
                    if (config.backup_url) settings['Current URL'] = config.backup_url;
                } else {
                    settings['Current Server'] = 'Secondary';
                }
                if (config.backup_key) settings['Stream Key'] = config.backup_key;
            } else {
                if (config.platform === 'Custom' || config.platform === 'Custom URL H.264') {
                    settings['Current Server'] = 'Custom';
                    if (config.primary_url) settings['Current URL'] = config.primary_url;
                } else {
                    settings['Current Server'] = 'Primary';
                }
                if (config.primary_key) settings['Stream Key'] = config.primary_key;
            }
        }

        // If device is currently streaming, queue changes instead of pushing
        const state = wpStateCache[device.host] || {};
        if (state.streaming) {
            wpQueueChangeForHost(device.host, settings);
            queuedCount++;
            continue;
        }

        try {
            const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/${device.host}/settings` : `/api/wp/${device.host}/settings`;
            const res = await fetch(url, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(settings) });
            if (res.ok) successCount++;
        } catch (_) {}
    }
    let msg = `Pushed to ${successCount} device(s)`;
    if (queuedCount > 0) msg += `, queued ${queuedCount} (streaming — will apply after stream ends)`;
    showToast(msg, successCount === devices.length ? 'success' : 'warning');
}

async function wpFetchKeys() {
    const select = document.getElementById('wp-key-plugin-select');
    const status = document.getElementById('wp-key-plugin-status');
    const pluginName = select?.value;
    if (!pluginName) { showToast('Select a key provider first', 'warning'); return; }

    if (status) status.textContent = 'Fetching keys...';
    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/plugins/keys/fetch/${pluginName}` : `/api/wp/plugins/keys/fetch/${pluginName}`;
    try {
        const res = await fetch(url, { method: 'POST' });
        const data = await res.json();
        if (data.error) {
            if (status) status.textContent = data.error;
            return;
        }
        const saveUrl = WP_API_BASE ? `${WP_API_BASE}/api/wp/active` : '/api/wp/active';
        await fetch(saveUrl, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(data),
        });
        wpLoadActiveToForm();
        if (status) status.textContent = `Keys loaded for "${data.primary_url || 'custom'}"`;
        showToast('Stream keys fetched and applied', 'success');
    } catch (_) {
        if (status) status.textContent = 'Failed to fetch keys.';
    }
}

// --- WP Active Metadata Schedule Panel ---
async function wpLoadPluginSelector() {
    const url = HD_API_BASE ? `${HD_API_BASE}/api/plugins` : '/api/plugins';
    try {
        const res = await fetch(url);
        const plugins = await res.json();
        const select = document.getElementById('wp-plugin-selector');
        if (!select) return;
        select.innerHTML = '<option value="">Manual Entry Only</option>';
        (Array.isArray(plugins) ? plugins : []).forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.name;
            opt.textContent = p.label || p.name;
            opt.disabled = p.enabled === false;
            select.appendChild(opt);
        });
        if (!select.dataset.bound) {
            select.addEventListener('change', () => {
                const desc = document.getElementById('wp-plugin-description');
                const syncBtn = document.getElementById('wp-btn-plugin-sync');
                const uploadPanel = document.getElementById('wp-plugin-upload-panel');
                const plugin = (typeof availablePlugins !== 'undefined' ? availablePlugins : []).find(pl => pl.name === select.value);
                if (!select.value) {
                    if (desc) desc.textContent = 'No plugin selected. Manual schedule editing is active.';
                    if (syncBtn) { syncBtn.disabled = false; syncBtn.textContent = 'Fetch & Sync Schedule'; }
                    if (uploadPanel) uploadPanel.classList.add('hidden');
                } else {
                    if (desc) desc.textContent = plugin?.description || '';
                    if (plugin?.supports_upload) {
                        if (syncBtn) { syncBtn.disabled = true; syncBtn.textContent = 'Use Upload Below'; }
                        if (uploadPanel) uploadPanel.classList.remove('hidden');
                    } else {
                        if (syncBtn) { syncBtn.disabled = false; syncBtn.textContent = 'Fetch & Sync Schedule'; }
                        if (uploadPanel) uploadPanel.classList.add('hidden');
                    }
                }
            });
            select.dataset.bound = 'true';
        }
    } catch (_) {}
}

async function wpTriggerPluginSync() {
    const select = document.getElementById('wp-plugin-selector');
    const status = document.getElementById('wp-plugin-sync-status');
    const pluginName = select?.value;
    if (!pluginName) {
        showToast('Select a schedule plugin first', 'warning');
        return;
    }

    const plugin = (typeof availablePlugins !== 'undefined' ? availablePlugins : []).find(p => p.name === pluginName);
    if (plugin?.supports_upload) {
        if (status) status.textContent = 'This plugin requires file upload. Use the upload panel below.';
        return;
    }

    if (status) status.textContent = 'Syncing...';
    const url = HD_API_BASE ? `${HD_API_BASE}/api/plugins/run/${pluginName}` : `/api/plugins/run/${pluginName}`;
    try {
        const res = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
        const data = await res.json();
        if (data.status === 'success') {
            await loadWpSchedule();
            if (status) status.textContent = `Last sync: ${data.items_synced || 0} rows loaded from ${pluginName}`;
            showToast(`Synced ${data.items_synced || 0} events`, 'success');
        } else {
            if (status) status.textContent = data.message || 'Sync returned no data';
        }
    } catch (_) {
        if (status) status.textContent = 'Sync failed — is HyperDeck service running?';
    }
}

async function wpUploadScheduleFile() {
    const select = document.getElementById('wp-plugin-selector');
    const fileInput = document.getElementById('wp-plugin-file-input');
    const status = document.getElementById('wp-plugin-upload-status');
    const pluginName = select?.value;
    if (!pluginName) { showToast('Select a plugin first', 'warning'); return; }
    if (!fileInput?.files[0]) { showToast('Select a file first', 'warning'); return; }

    if (status) status.textContent = 'Uploading...';
    const formData = new FormData();
    formData.append('file', fileInput.files[0]);

    const url = HD_API_BASE ? `${HD_API_BASE}/api/plugins/upload/${pluginName}` : `/api/plugins/upload/${pluginName}`;
    try {
        const res = await fetch(url, {method: 'POST', body: formData});
        const data = await res.json();
        if (data.status === 'success') {
            await loadWpSchedule();
            if (status) status.textContent = `Uploaded: ${data.items_synced || 0} rows loaded`;
            showToast(`Uploaded ${data.items_synced || 0} events`, 'success');
        } else {
            if (status) status.textContent = data.message || 'Upload returned no data';
        }
    } catch (_) {
        if (status) status.textContent = 'Upload failed';
    }
}

function wpUpdateStagedEventHud() {
    const titleEl = document.getElementById('wp-hud-active-title');
    const idEl = document.getElementById('wp-hud-active-id');
    const modeEl = document.getElementById('wp-hud-mode-badge');
    const clearBtn = document.getElementById('wp-btn-clear-context');
    if (!titleEl) return;

    if (typeof globallyActiveEventId !== 'undefined' && globallyActiveEventId && globallyActiveEventId !== 'default') {
        const event = scheduleDataCache.find(e => e.id === globallyActiveEventId);
        if (event) {
            titleEl.textContent = event.planned_title || event.id || 'Untitled Event';
            idEl.textContent = event.id || '';
            if (modeEl) { modeEl.textContent = 'MANUAL'; modeEl.className = 'text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30'; }
            if (clearBtn) clearBtn.classList.remove('hidden');
        }
    } else {
        titleEl.textContent = 'Default (Time & Date Fallback)';
        idEl.textContent = 'No active event selection';
        if (modeEl) { modeEl.textContent = 'AUTO'; modeEl.className = 'text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'; }
        if (clearBtn) clearBtn.classList.add('hidden');
    }
}

function wpClearActiveEvent() {
    globallyActiveEventId = 'default';
    wpUpdateStagedEventHud();
    const url = HD_API_BASE ? `${HD_API_BASE}/api/schedule/active` : '/api/schedule/active';
    fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: ''})});
}

// --- WP Schedule (uses shared scheduleDataCache) ---

async function loadWpSchedule() {
    const url = HD_API_BASE ? `${HD_API_BASE}/api/schedule` : '/api/schedule';
    try {
        const res = await fetch(url);
        const data = await res.json();
        scheduleDataCache = Array.isArray(data) ? data : [];
        wpFilterSchedule();
        wpUpdateStageSelectors();
    } catch (_) {
        const wpUrl = WP_API_BASE ? `${WP_API_BASE}/api/wp/schedule` : '/api/wp/schedule';
        try {
            const res = await fetch(wpUrl);
            const data = await res.json();
            scheduleDataCache = Array.isArray(data) ? data : [];
            wpFilterSchedule();
            wpUpdateStageSelectors();
        } catch (_) {}
    }
}

function wpUpdateStageSelectors() {
    const stages = new Set(scheduleDataCache.map(e => e.stage).filter(Boolean));
    Object.values(wpPresentersConfig).forEach(p => { if (p.stage) stages.add(p.stage); });

    const datalist = document.getElementById('wp-stage-options');
    if (datalist) {
        datalist.innerHTML = '';
        stages.forEach(s => { const opt = document.createElement('option'); opt.value = s; datalist.appendChild(opt); });
    }
    const pushStage = document.getElementById('wp-push-stage');
    if (pushStage && document.getElementById('wp-push-target')?.value === 'stage') {
        const current = pushStage.value;
        pushStage.innerHTML = '<option value="">Select stage...</option>';
        stages.forEach(s => { const opt = document.createElement('option'); opt.value = s; opt.textContent = s; pushStage.appendChild(opt); });
        pushStage.value = current;
    }
}
function wpFilterSchedule() {
    const filter = document.getElementById('wp-schedule-filter')?.value || 'all';
    const container = document.getElementById('wp-schedule-matrix');
    const counter = document.getElementById('wp-schedule-counter');
    if (!container) return;

    let filtered = Array.isArray(scheduleDataCache) ? [...scheduleDataCache] : [];

    if (filter === 'in_scope') {
        filtered = filtered.filter(item => isScheduleItemInScope(item));
    }

    container.innerHTML = '';
    if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'text-[11px] text-slate-500 italic px-1 py-1';
        empty.innerText = filter === 'in_scope' ? 'No rows match current stage scope.' : 'No schedule events. Add events or sync from a plugin.';
        container.appendChild(empty);
        if (counter) counter.textContent = '0 records';
        return;
    }

    if (counter) {
        if (filter === 'in_scope') {
            counter.textContent = `${filtered.length}/${scheduleDataCache.length} in scope`;
        } else {
            counter.textContent = `${scheduleDataCache.length} records`;
        }
    }

    const showStreamSettings = activeTab === 'webpresenter';

    filtered.forEach(item => {
        const row = createScheduleRowElement(item);
        container.appendChild(row);

        // Show/hide stream settings based on active tab
        const toggle = row.querySelector('.wp-stream-toggle');
        if (toggle) {
            toggle.style.display = showStreamSettings ? '' : 'none';
        }

        // Re-expand stream settings if they were open before re-render
        const key = row.dataset.rowKey;
        if (showStreamSettings && expandedStreamRows.has(key)) {
            const fields = row.querySelector('.sch-stream-fields');
            const btn = Array.from(row.querySelectorAll('button')).find(b => b.textContent.includes('Stream Settings'));
            if (fields && btn) {
                fields.style.display = '';
                fields.classList.remove('hidden');
                btn.innerText = 'Hide Stream Settings';
                const select = fields.querySelector('.sch-stream-profile');
                if (select && select.value) {
                    loadWpProfilesIntoSelect(select, select.value);
                    fields.querySelectorAll('input, select').forEach(f => {
                        if (f.classList.contains('sch-stream-profile')) return;
                        f.disabled = true;
                        f.classList.add('opacity-60');
                    });
                }
                const protocolSelect = fields.querySelector('.sch-protocol');
                if (protocolSelect) wpOnRowProtocolChanged(protocolSelect);
            }
        }
    });
}

function wpStageEvent(idx) {
    const item = scheduleDataCache[idx];
    if (!item) return;

    // Merge any inline edits first
    mergeVisibleRowsIntoCache();
    const merged = scheduleDataCache[idx];

    const config = {
        event_id: merged.id || '',
        title: merged.planned_title || merged.id || '',
        primary_url: merged.primary_url || '',
        primary_key: merged.primary_key || '',
        backup_url: merged.backup_url || '',
        backup_key: merged.backup_key || '',
        quality: merged.quality || '',
        video_mode: merged.video_mode || '',
        platform: merged.platform || '',
        protocol: merged.protocol || 'rtmp',
        stream_profile: merged.stream_profile || '',
    };

    if (merged.stream_profile) {
        wpApplyProfile(merged.stream_profile);
    }

    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/active` : '/api/wp/active';
    fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(config),
    }).then(() => {
        wpLoadActiveToForm();
        showToast(`Staged: ${merged.planned_title || merged.id || 'event'}`, 'success');
    }).catch(() => showToast('Failed to stage event', 'error'));
}

function wpAddEvent() {
    scheduleDataCache.push({
        id: `evt_${Date.now()}`,
        planned_title: '',
        start_time: '',
        stage: '',
        primary_key: '',
        primary_url: '',
    });
    wpFilterSchedule();
    // Scroll to the new row and focus the title field
    const container = document.getElementById('wp-schedule-matrix');
    if (container) {
        const lastRow = container.lastElementChild;
        if (lastRow) {
            lastRow.scrollIntoView({behavior: 'smooth', block: 'end'});
            const titleInput = lastRow.querySelector('.sch-title');
            if (titleInput) titleInput.focus();
        }
    }
}

async function wpSaveSchedule() {
    mergeVisibleRowsIntoCache();
    const url = HD_API_BASE ? `${HD_API_BASE}/api/schedule` : '/api/schedule';
    try {
        await fetch(url, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(scheduleDataCache),
        });
        wpFilterSchedule();
        showToast('Schedule saved', 'success');
    } catch (_) {
        const wpUrl = WP_API_BASE ? `${WP_API_BASE}/api/wp/schedule` : '/api/wp/schedule';
        try {
            await fetch(wpUrl, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(scheduleDataCache),
            });
            wpFilterSchedule();
            showToast('Schedule saved', 'success');
        } catch (_) {
            showToast('Failed to save schedule', 'error');
        }
    }
}

// --- YouTube Config ---
async function loadYoutubeConfig() {
    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/plugins/keys/youtube/config` : '/api/wp/plugins/keys/youtube/config';
    try {
        const res = await fetch(url);
        const data = await res.json();
        document.getElementById('yt-client-id').value = data.client_id || '';
        document.getElementById('yt-client-secret').value = data.client_secret === '***' ? '' : (data.client_secret || '');
        const status = document.getElementById('yt-config-status');
        if (data.configured) {
            status.textContent = 'Credentials configured — ready to sign in';
            status.className = 'text-[10px] text-emerald-400';
        } else {
            status.textContent = 'Enter Client ID and Secret, then save before signing in';
            status.className = 'text-[10px] text-slate-500';
        }
    } catch (_) {}
}

async function saveYoutubeConfig() {
    const clientId = document.getElementById('yt-client-id').value.trim();
    const clientSecret = document.getElementById('yt-client-secret').value.trim();
    const status = document.getElementById('yt-config-status');

    if (!clientId || !clientSecret) {
        showToast('Client ID and Client Secret are required', 'warning');
        return;
    }

    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/plugins/keys/youtube/config` : '/api/wp/plugins/keys/youtube/config';
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({client_id: clientId, client_secret: clientSecret}),
        });
        const data = await res.json();
        if (data.configured) {
            status.textContent = 'Credentials saved — ready to sign in';
            status.className = 'text-[10px] text-emerald-400';
            showToast('YouTube credentials saved', 'success');
        }
    } catch (_) {
        showToast('Failed to save YouTube credentials', 'error');
    }
}

async function youtubeSignIn() {
    const clientId = document.getElementById('yt-client-id').value.trim();
    const clientSecret = document.getElementById('yt-client-secret').value.trim();
    const status = document.getElementById('yt-config-status');

    if (!clientId || !clientSecret) {
        showToast('Save Client ID and Secret first', 'warning');
        return;
    }

    // Save credentials first
    await saveYoutubeConfig();

    const url = WP_API_BASE ? `${WP_API_BASE}/api/wp/plugins/keys/youtube/authorize` : '/api/wp/plugins/keys/youtube/authorize';
    try {
        const res = await fetch(url);
        const data = await res.json();
        if (data.auth_url) {
            status.textContent = 'Opening Google sign-in...';
            status.className = 'text-[10px] text-indigo-400';
            window.open(data.auth_url, 'youtube_auth', 'width=500,height=600,left=200,top=200');
        } else {
            status.textContent = 'Failed to generate auth URL';
            status.className = 'text-[10px] text-rose-400';
        }
    } catch (_) {
        status.textContent = 'Failed to connect to server';
        status.className = 'text-[10px] text-rose-400';
    }
}

// Listen for OAuth2 callback messages from popup
window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'youtube_auth') {
        const status = document.getElementById('yt-config-status');
        if (event.data.success) {
            if (status) {
                status.textContent = 'YouTube account connected!';
                status.className = 'text-[10px] text-emerald-400';
            }
            showToast('YouTube account connected successfully', 'success');
            loadYoutubeConfig();
        } else {
            if (status) {
                status.textContent = 'Authorization failed — try again';
                status.className = 'text-[10px] text-rose-400';
            }
            showToast('YouTube authorization failed', 'error');
        }
    }
});

function showYoutubeSetupGuide() {
    const title = document.getElementById('guide-modal-title');
    const content = document.getElementById('guide-modal-content');
    title.textContent = 'YouTube Live Setup Guide';
    content.innerHTML = `
        <div class="space-y-4">
            <h4 class="font-semibold text-white">Step 1: Create a Google Cloud Project</h4>
            <ol class="list-decimal list-inside space-y-1 text-slate-400">
                <li>Go to <a href="https://console.cloud.google.com/" target="_blank" class="text-indigo-400 hover:underline">Google Cloud Console</a></li>
                <li>Create a new project (e.g. "HyperDeck YouTube Integration")</li>
                <li>Select the project from the top dropdown</li>
            </ol>

            <h4 class="font-semibold text-white">Step 2: Enable the YouTube Data API</h4>
            <ol class="list-decimal list-inside space-y-1 text-slate-400">
                <li>Go to <strong>APIs & Services > Library</strong></li>
                <li>Search for "YouTube Data API v3"</li>
                <li>Click <strong>Enable</strong></li>
            </ol>

            <h4 class="font-semibold text-white">Step 3: Create OAuth2 Credentials</h4>
            <ol class="list-decimal list-inside space-y-1 text-slate-400">
                <li>Go to <strong>APIs & Services > Credentials</strong></li>
                <li>Click <strong>Create Credentials > OAuth client ID</strong></li>
                <li>If prompted, configure the OAuth consent screen first:
                    <ul class="list-disc list-inside ml-4 mt-1 text-slate-500">
                        <li>User Type: <strong>External</strong></li>
                        <li>App name: "HyperDeck Tools" (or your choice)</li>
                        <li>Add your email as test user</li>
                    </ul>
                </li>
                <li>For Application type, select <strong>Web application</strong></li>
                <li>Name it (e.g. "HyperDeck Web")</li>
                <li>Under <strong>Authorized redirect URIs</strong>, add:
                    <div class="bg-slate-950 border border-slate-800 rounded p-2 mt-1 font-mono text-[11px] text-slate-300" id="yt-redirect-uri">Loading...</div>
                </li>
                <li>Click <strong>Create</strong></li>
                <li>Copy the <strong>Client ID</strong> and <strong>Client Secret</strong></li>
            </ol>

            <h4 class="font-semibold text-white">Step 4: Configure in This App</h4>
            <ol class="list-decimal list-inside space-y-1 text-slate-400">
                <li>Paste your <strong>Client ID</strong> and <strong>Client Secret</strong> above</li>
                <li>Click <strong>Save Credentials</strong></li>
                <li>Click <strong>Sign in with Google</strong></li>
                <li>Authorize the app in the Google popup</li>
                <li>The refresh token is saved automatically</li>
            </ol>

            <div class="bg-slate-800/50 border border-slate-700 rounded p-3 text-xs text-slate-400">
                <strong class="text-slate-300">Note:</strong> You need an active YouTube Live broadcast for key fetching to work.
                Create one in YouTube Studio before clicking Fetch Keys.
            </div>
        </div>
    `;
    document.getElementById('guide-modal').classList.remove('hidden');

    // Set the redirect URI dynamically
    const redirectEl = document.getElementById('yt-redirect-uri');
    if (redirectEl) {
        const base = WP_API_BASE || '';
        redirectEl.textContent = `${base}/api/wp/plugins/keys/youtube/callback`;
    }
}

function closeGuideModal() {
    document.getElementById('guide-modal').classList.add('hidden');
}

// --- Init & Service Detection ---
async function _detectServices() {
    const tabEl = document.getElementById('app-tabs');
    const hdTab = document.getElementById('tab-hyperdeck');
    const wpTab = document.getElementById('tab-webpresenter');

    // Always show current service's tab
    if (IS_HD) {
        hdTab.style.display = '';
        wpTab.style.display = 'none';
    } else if (IS_WP) {
        hdTab.style.display = 'none';
        wpTab.style.display = '';
    }

    // Probe the other service
    if (IS_HD) {
        // We're on HyperDeck, probe WP
        try {
            const res = await fetch(`${WP_API_BASE}/api/wp/state`, {signal: AbortSignal.timeout(2000)});
            if (res.ok) {
                servicesAvailable.webpresenter = true;
                wpTab.style.display = '';
            }
        } catch (_) {}
    } else if (IS_WP) {
        // We're on WP, probe HyperDeck
        try {
            const res = await fetch(`${HD_API_BASE}/api/state`, {signal: AbortSignal.timeout(2000)});
            if (res.ok) {
                servicesAvailable.hyperdeck = true;
                hdTab.style.display = '';
            }
        } catch (_) {}
    }

    // If only one service, hide tab bar
    const visibleCount = [servicesAvailable.hyperdeck, servicesAvailable.webpresenter].filter(Boolean).length;
    if (visibleCount <= 1) {
        tabEl.style.display = 'none';
    } else {
        tabEl.style.display = '';
    }

    // Set default tab and load its data
    switchAppTab(activeTab);

    // If the other service was detected, preload its data
    if (IS_HD && servicesAvailable.webpresenter) {
        loadWpPresenters();
    } else if (IS_WP && servicesAvailable.hyperdeck) {
        // HD data loads on demand when tab is clicked
    }
}

(function _init() {
    setTimeout(_detectServices, 200);
})();