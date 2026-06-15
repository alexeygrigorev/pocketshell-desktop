import type { ActivePortForward, PortForwardState } from './port-forward-manager';

export interface PortForwardPanelHost {
  id: number;
  name?: string;
  hostname: string;
  username?: string;
  port?: number;
}

export interface SavedPortForwardPanelMapping {
  id: string;
  hostId: number;
  name?: string;
  localHost?: string;
  localPort?: number;
  remoteHost: string;
  remotePort: number;
}

export interface PortForwardOpenArgs {
  hostId?: number;
  prefill: PortForwardFormState;
}

export interface PortForwardFormState {
  id?: string;
  name?: string;
  localHost?: string;
  localPort?: number | string;
  remoteHost?: string;
  remotePort?: number | string;
}

export interface PortForwardValidationResult {
  ok: boolean;
  errors: string[];
  value?: SavedPortForwardPanelMapping;
}

export type PortForwardRowState = PortForwardState | 'saved';
export type PortForwardStatusTone = 'muted' | 'info' | 'success' | 'warning' | 'error';

export interface PortForwardPanelRow {
  rowId: string;
  savedId?: string;
  activeId?: string;
  editForm?: PortForwardFormState;
  name: string;
  localHost: string;
  localPort?: number;
  remoteHost: string;
  remotePort: number;
  state: PortForwardRowState;
  statusLabel: string;
  statusTone: PortForwardStatusTone;
  errorText?: string;
  activeChannels: number;
  localUrl?: string;
  canEdit: boolean;
  canDelete: boolean;
  canStart: boolean;
  canStop: boolean;
  canCopy: boolean;
  canOpen: boolean;
}

export interface PortForwardPanelStatus {
  tone: PortForwardStatusTone;
  message: string;
}

export interface PortForwardPanelModel {
  host: PortForwardPanelHost;
  title: string;
  saved: SavedPortForwardPanelMapping[];
  rows: PortForwardPanelRow[];
  form: PortForwardFormState;
  status?: PortForwardPanelStatus;
  emptyText: string;
}

export interface BuildPortForwardPanelModelInput {
  host: PortForwardPanelHost;
  savedForwards: SavedPortForwardPanelMapping[];
  activeForwards: ActivePortForward[];
  prefill?: PortForwardFormState;
  status?: PortForwardPanelStatus;
}

const DEFAULT_LOCAL_HOST = '127.0.0.1';
const DEFAULT_REMOTE_HOST = '127.0.0.1';

export function buildPortForwardPanelModel(input: BuildPortForwardPanelModelInput): PortForwardPanelModel {
  const hostSaved = input.savedForwards
    .map((saved) => normalizeSavedPortForward(saved, input.host.id))
    .filter((saved): saved is SavedPortForwardPanelMapping => saved !== undefined);
  const hostActive = input.activeForwards.filter((active) => active.hostId === input.host.id);
  const activeById = new Map(hostActive.map((active) => [active.id, active]));
  const rows: PortForwardPanelRow[] = [];

  for (const saved of hostSaved) {
    rows.push(toPanelRow(saved, activeById.get(saved.id)));
    activeById.delete(saved.id);
  }
  for (const active of activeById.values()) {
    rows.push(toPanelRow(undefined, active));
  }

  rows.sort((a, b) => {
    const byRemotePort = a.remotePort - b.remotePort;
    if (byRemotePort !== 0) {
      return byRemotePort;
    }
    return a.name.localeCompare(b.name);
  });

  const title = input.host.name || input.host.hostname;
  return {
    host: input.host,
    title,
    saved: hostSaved,
    rows,
    form: defaultPortForwardForm(input.prefill),
    status: input.status,
    emptyText: 'No saved or active forwards for this host.',
  };
}

export function validatePortForwardInput(
  input: PortForwardFormState,
  hostId: number,
): PortForwardValidationResult {
  const errors: string[] = [];
  const remoteHost = (input.remoteHost ?? DEFAULT_REMOTE_HOST).trim();
  const localHost = (input.localHost ?? DEFAULT_LOCAL_HOST).trim();
  const remotePort = normalizePort(input.remotePort);
  const localPort = input.localPort === undefined || input.localPort === '' ? undefined : normalizePort(input.localPort);

  if (!remoteHost) {
    errors.push('Remote host is required.');
  }
  if (!localHost) {
    errors.push('Local host is required.');
  }
  if (remotePort === undefined) {
    errors.push('Remote port must be between 1 and 65535.');
  }
  if (input.localPort !== undefined && input.localPort !== '' && localPort === undefined) {
    errors.push('Local port must be blank or between 1 and 65535.');
  }

  if (errors.length > 0 || remotePort === undefined) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    value: {
      id: input.id?.trim() || '',
      hostId,
      name: trimOptional(input.name),
      localHost,
      localPort,
      remoteHost,
      remotePort,
    },
  };
}

export function normalizePortForwardOpenArgs(input: unknown): PortForwardOpenArgs {
  const record = isRecord(input) ? input : {};
  const prefillSource = isRecord(record.prefill) ? record.prefill : record;
  return {
    hostId: numberField(record, 'hostId'),
    prefill: defaultPortForwardForm({
      id: stringField(prefillSource, 'id'),
      name: stringField(prefillSource, 'name'),
      localHost: stringField(prefillSource, 'localHost'),
      localPort: portField(prefillSource, 'localPort'),
      remoteHost: stringField(prefillSource, 'remoteHost'),
      remotePort: portField(prefillSource, 'remotePort') ?? portField(prefillSource, 'port'),
    }),
  };
}

export function normalizeSavedPortForward(
  input: unknown,
  hostId: number,
): SavedPortForwardPanelMapping | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const id = stringField(input, 'id')?.trim();
  const inputHostId = numberField(input, 'hostId');
  const remoteHost = stringField(input, 'remoteHost')?.trim();
  const remotePort = portField(input, 'remotePort');
  if (!id || inputHostId !== hostId || !remoteHost || remotePort === undefined) {
    return undefined;
  }
  return {
    id,
    hostId,
    name: trimOptional(stringField(input, 'name')),
    localHost: stringField(input, 'localHost')?.trim() || DEFAULT_LOCAL_HOST,
    localPort: portField(input, 'localPort'),
    remoteHost,
    remotePort,
  };
}

export function formatLocalUrl(forward: Pick<ActivePortForward, 'localHost' | 'localPort' | 'state'>): string | undefined {
  if (forward.state !== 'listening' || forward.localPort <= 0) {
    return undefined;
  }
  const host = forward.localHost === '0.0.0.0' ? 'localhost' : forward.localHost;
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${urlHost}:${forward.localPort}`;
}

export function resolveActivePortForwardLocalUrl(
  activeForwards: readonly ActivePortForward[],
  hostId: number,
  activeId: string | undefined,
): string | undefined {
  if (!activeId) {
    return undefined;
  }
  const forward = activeForwards.find((item) => item.id === activeId && item.hostId === hostId);
  return forward ? formatLocalUrl(forward) : undefined;
}

export function renderPortForwardHtml(
  model: PortForwardPanelModel,
  options: { cspSource?: string; nonce?: string } = {},
): string {
  const nonceAttribute = options.nonce ? ` nonce="${escapeHtml(options.nonce)}"` : '';
  const csp = renderContentSecurityPolicy(options);
  const cspMeta = csp
    ? `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">\n`
    : '';
  const rowsJson = jsonForScript(model.rows);
  const formJson = jsonForScript(model.form);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${cspMeta}<meta name="viewport" content="width=device-width, initial-scale=1">
<style${nonceAttribute}>
:root { color-scheme: light dark; }
body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
.panel { box-sizing: border-box; min-height: 100vh; display: grid; grid-template-rows: auto auto 1fr; }
.header { display: flex; align-items: baseline; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--vscode-panel-border); }
.title { font-weight: 600; }
.subtitle { color: var(--vscode-descriptionForeground); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.form { display: grid; grid-template-columns: minmax(110px, 1.2fr) minmax(110px, 1fr) minmax(80px, 0.7fr) minmax(110px, 1fr) minmax(80px, 0.7fr) auto; gap: 8px; align-items: end; padding: 12px 14px; border-bottom: 1px solid var(--vscode-panel-border); }
label { display: grid; gap: 4px; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
input { box-sizing: border-box; width: 100%; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 5px 7px; border-radius: 4px; font: inherit; }
.form-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
button { border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); padding: 5px 9px; border-radius: 4px; cursor: pointer; white-space: nowrap; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.icon { min-width: 28px; padding-inline: 7px; }
button:disabled { opacity: 0.55; cursor: default; }
.content { padding: 12px 14px; overflow: auto; }
.status { margin-bottom: 10px; padding: 7px 9px; border-left: 3px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); }
.status[data-tone="success"] { border-left-color: var(--vscode-testing-iconPassed); }
.status[data-tone="error"] { border-left-color: var(--vscode-errorForeground); }
.status[data-tone="warning"] { border-left-color: var(--vscode-notificationsWarningIcon-foreground); }
.empty { color: var(--vscode-descriptionForeground); padding: 16px 0; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { padding: 7px 8px; border-bottom: 1px solid var(--vscode-panel-border); text-align: left; vertical-align: middle; }
th { color: var(--vscode-descriptionForeground); font-weight: 500; }
.name { font-weight: 600; overflow-wrap: anywhere; }
.muted { color: var(--vscode-descriptionForeground); }
.url { font-family: var(--vscode-editor-font-family); overflow-wrap: anywhere; }
.badge { display: inline-block; padding: 2px 6px; border-radius: 4px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.badge[data-tone="muted"] { background: var(--vscode-editorWidget-background); color: var(--vscode-descriptionForeground); }
.badge[data-tone="success"] { background: var(--vscode-testing-iconPassed); color: var(--vscode-editor-background); }
.badge[data-tone="error"] { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); }
.badge[data-tone="warning"] { background: var(--vscode-inputValidation-warningBackground); color: var(--vscode-notificationsWarningIcon-foreground); }
.row-actions { display: flex; gap: 5px; flex-wrap: wrap; }
@media (max-width: 820px) {
  .form { grid-template-columns: 1fr 1fr; }
  .form-actions { grid-column: 1 / -1; }
  table, thead, tbody, tr, th, td { display: block; }
  thead { display: none; }
  tr { border-bottom: 1px solid var(--vscode-panel-border); padding: 8px 0; }
  td { border-bottom: 0; padding: 4px 0; }
}
</style>
</head>
<body>
<section class="panel" aria-label="Port forwarding">
  <header class="header">
    <div class="title">Port Forwarding</div>
    <div class="subtitle">${escapeHtml(model.title)}</div>
  </header>
  <form class="form" data-forward-form>
    <input type="hidden" name="id">
    <label>Name<input name="name" placeholder="Web app"></label>
    <label>Remote host<input name="remoteHost" placeholder="127.0.0.1"></label>
    <label>Remote port<input name="remotePort" inputmode="numeric" placeholder="3000"></label>
    <label>Local host<input name="localHost" placeholder="127.0.0.1"></label>
    <label>Local port<input name="localPort" inputmode="numeric" placeholder="auto"></label>
    <div class="form-actions">
      <button type="submit" data-action="save">Save</button>
      <button type="button" data-action="save-start">Save & Start</button>
      <button type="button" class="secondary" data-action="reset">Clear</button>
    </div>
  </form>
  <main class="content">
    ${model.status ? `<div class="status" role="status" data-tone="${escapeHtml(model.status.tone)}">${escapeHtml(model.status.message)}</div>` : ''}
    ${model.rows.length === 0 ? `<div class="empty">${escapeHtml(model.emptyText)}</div>` : renderRows(model.rows)}
  </main>
</section>
<script${nonceAttribute}>
const vscode = acquireVsCodeApi();
const rows = ${rowsJson};
const initialForm = ${formJson};
const form = document.querySelector('[data-forward-form]');
function setForm(values) {
  if (!form) return;
  for (const name of ['id', 'name', 'remoteHost', 'remotePort', 'localHost', 'localPort']) {
    const input = form.elements[name];
    if (!input) continue;
    input.value = values?.[name] ?? '';
  }
}
function readForm() {
  const result = {};
  if (!form) return result;
  for (const name of ['id', 'name', 'remoteHost', 'remotePort', 'localHost', 'localPort']) {
    const input = form.elements[name];
    if (!input) continue;
    result[name] = input.value;
  }
  return result;
}
function rowData(button) {
  const id = button.closest('[data-row-id]')?.dataset.rowId;
  return rows.find((row) => row.rowId === id);
}
form?.addEventListener('submit', (event) => {
  event.preventDefault();
  vscode.postMessage({ action: 'save', form: readForm() });
});
document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'save-start') {
    vscode.postMessage({ action: 'save-start', form: readForm() });
    return;
  }
  if (action === 'reset') {
    setForm({});
    return;
  }
  const row = rowData(button);
  if (!row) return;
  if (action === 'edit') {
    setForm(row.editForm ?? {});
    form?.querySelector('input[name="name"]')?.focus();
    return;
  }
  vscode.postMessage({ action, savedId: row.savedId, activeId: row.activeId });
});
window.addEventListener('load', () => setForm(initialForm));
</script>
</body>
</html>`;
}

function toPanelRow(
  saved: SavedPortForwardPanelMapping | undefined,
  active: ActivePortForward | undefined,
): PortForwardPanelRow {
  const state: PortForwardRowState = active?.state ?? 'saved';
  const localHost = active?.localHost ?? saved?.localHost ?? DEFAULT_LOCAL_HOST;
  const localPort = active?.localPort || saved?.localPort;
  const remoteHost = active?.remoteHost ?? saved?.remoteHost ?? DEFAULT_REMOTE_HOST;
  const remotePort = active?.remotePort ?? saved?.remotePort ?? 0;
  const status = statusForState(state, active?.error?.message);
  const localUrl = active ? formatLocalUrl(active) : undefined;
  const name = active?.name || saved?.name || `${remoteHost}:${remotePort}`;
  return {
    rowId: saved?.id ?? active?.id ?? `${remoteHost}:${remotePort}`,
    savedId: saved?.id,
    activeId: active?.id,
    editForm: saved ? savedToForm(saved) : undefined,
    name,
    localHost,
    localPort,
    remoteHost,
    remotePort,
    state,
    statusLabel: status.label,
    statusTone: status.tone,
    errorText: active?.error?.message,
    activeChannels: active?.activeChannels ?? 0,
    localUrl,
    canEdit: Boolean(saved),
    canDelete: Boolean(saved),
    canStart: Boolean(saved) && !active,
    canStop: active?.state === 'listening' || active?.state === 'starting',
    canCopy: Boolean(localUrl),
    canOpen: Boolean(localUrl),
  };
}

function savedToForm(saved: SavedPortForwardPanelMapping): PortForwardFormState {
  return {
    id: saved.id,
    name: saved.name,
    localHost: saved.localHost ?? DEFAULT_LOCAL_HOST,
    localPort: saved.localPort,
    remoteHost: saved.remoteHost,
    remotePort: saved.remotePort,
  };
}

function renderRows(rows: PortForwardPanelRow[]): string {
  return `<table>
<thead><tr><th>Name</th><th>Remote</th><th>Local URL</th><th>Status</th><th>Actions</th></tr></thead>
<tbody>
${rows.map((row) => `<tr data-row-id="${escapeHtml(row.rowId)}">
  <td><div class="name">${escapeHtml(row.name)}</div><div class="muted">${escapeHtml(row.localHost)}${row.localPort ? `:${row.localPort}` : ':auto'}</div></td>
  <td>${escapeHtml(row.remoteHost)}:${row.remotePort}</td>
  <td>${row.localUrl ? `<span class="url">${escapeHtml(row.localUrl)}</span>` : '<span class="muted">Not listening</span>'}</td>
  <td><span class="badge" data-tone="${escapeHtml(row.statusTone)}">${escapeHtml(row.statusLabel)}</span>${row.errorText ? `<div class="muted">${escapeHtml(row.errorText)}</div>` : ''}</td>
  <td><div class="row-actions">${renderRowActions(row)}</div></td>
</tr>`).join('')}
</tbody>
</table>`;
}

function renderRowActions(row: PortForwardPanelRow): string {
  const buttons = [
    row.canStart ? '<button type="button" data-action="start">Start</button>' : '',
    row.canStop ? '<button type="button" class="secondary" data-action="stop">Stop</button>' : '',
    row.canCopy ? '<button type="button" class="secondary" data-action="copy">Copy</button>' : '',
    row.canOpen ? '<button type="button" class="secondary" data-action="open">Open</button>' : '',
    row.canEdit ? '<button type="button" class="secondary" data-action="edit">Edit</button>' : '',
    row.canDelete ? '<button type="button" class="secondary" data-action="delete">Delete</button>' : '',
  ];
  return buttons.filter(Boolean).join('');
}

function statusForState(state: PortForwardRowState, error?: string): { label: string; tone: PortForwardStatusTone } {
  if (error || state === 'error') {
    return { label: 'Error', tone: 'error' };
  }
  if (state === 'listening') {
    return { label: 'Listening', tone: 'success' };
  }
  if (state === 'starting') {
    return { label: 'Starting', tone: 'info' };
  }
  if (state === 'stopping') {
    return { label: 'Stopping', tone: 'warning' };
  }
  if (state === 'stopped') {
    return { label: 'Stopped', tone: 'muted' };
  }
  return { label: 'Saved', tone: 'muted' };
}

function defaultPortForwardForm(prefill: PortForwardFormState = {}): PortForwardFormState {
  return {
    id: prefill.id,
    name: prefill.name,
    localHost: prefill.localHost ?? DEFAULT_LOCAL_HOST,
    localPort: prefill.localPort,
    remoteHost: prefill.remoteHost ?? DEFAULT_REMOTE_HOST,
    remotePort: prefill.remotePort,
  };
}

function normalizePort(value: number | string | undefined): number | undefined {
  const port = typeof value === 'string' ? Number(value.trim()) : value;
  if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }
  return port;
}

function portField(value: Record<string, unknown>, key: string): number | undefined {
  const raw = value[key];
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return normalizePort(Math.trunc(raw));
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? normalizePort(Math.trunc(parsed)) : undefined;
  }
  return undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  return typeof value[key] === 'number' && Number.isFinite(value[key]) ? value[key] : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' ? value[key] : undefined;
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function renderContentSecurityPolicy(options: { cspSource?: string; nonce?: string }): string | undefined {
  if (!options.cspSource || !options.nonce) {
    return undefined;
  }
  const cspSource = escapeCspDirectiveValue(options.cspSource);
  const nonce = escapeCspDirectiveValue(options.nonce);
  return [
    "default-src 'none'",
    `style-src ${cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeCspDirectiveValue(value: string): string {
  return value.replace(/[\r\n;]/g, '');
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
