export interface HostDetailHost {
  id: number;
  name: string;
  hostname: string;
  port: number;
  username: string;
  enabled: boolean;
  lastConnectedAt: number | null;
  tmuxInstalled: boolean | null;
  lastBootstrapAt: number | null;
  pocketshellInstalled: boolean | null;
  pocketshellLastDetectedAt: number | null;
  pocketshellCliVersion: string | null;
  pocketshellExpectedCliVersion: string | null;
  pocketshellVersionCompatible: boolean | null;
  pocketshellDaemonRunning: boolean | null;
  pocketshellDaemonEnabled: boolean | null;
}

export interface HostDetailAction {
  label: string;
  command: string;
  args: unknown[];
  primary?: boolean;
}

export interface HostDetailFolder {
  id: number;
  label: string;
  path: string;
  source: 'manual' | 'discovered';
  enabled: boolean;
}

export interface HostDetailRow {
  label: string;
  detail?: string;
  meta?: string;
  actions?: HostDetailAction[];
}

export interface HostDetailSection {
  title: string;
  rows: Array<string | HostDetailRow>;
  empty?: string;
  actions?: HostDetailAction[];
}

export interface HostDetailModel {
  title: string;
  subtitle: string;
  connectionState: string;
  statusRows: string[];
  primaryActions: HostDetailAction[];
  sections: HostDetailSection[];
}

export interface HostDetailOptions {
  connectionState: string;
  watchedFolders?: HostDetailFolder[];
  now?: number;
}

export function buildHostDetailModel(
  host: HostDetailHost,
  options: HostDetailOptions,
): HostDetailModel {
  const title = host.name || host.hostname;
  const subtitle = `${host.username}@${host.hostname}:${host.port}`;
  const isConnected = options.connectionState === 'Connected';

  return {
    title,
    subtitle,
    connectionState: options.connectionState,
    statusRows: [
      `Connection: ${options.connectionState}`,
      `Host: ${subtitle}`,
      `Enabled: ${host.enabled ? 'yes' : 'no'}`,
      `Last connected: ${formatTimestamp(host.lastConnectedAt)}`,
    ],
    primaryActions: [
      { label: 'Open Terminal', command: 'pocketshell.connect', args: [host.id], primary: true },
      isConnected
        ? { label: 'Disconnect', command: 'pocketshell.disconnect', args: [host.id] }
        : { label: 'Connect', command: 'pocketshell.connect', args: [host.id] },
      { label: 'Browse Files', command: 'pocketshell.files.browse', args: [host.id] },
      { label: 'Usage', command: 'pocketshell.usage.show', args: [host.id] },
      { label: 'Tmux Sessions', command: 'pocketshell.tmux.list', args: [host.id] },
      { label: 'Edit Host', command: 'pocketshell.editHost', args: [host.id] },
    ],
    sections: [
      {
        title: 'Bootstrap',
        rows: [
          `PocketShell CLI: ${formatInstalled(host.pocketshellInstalled, host.pocketshellCliVersion)}`,
          `Expected CLI: ${host.pocketshellExpectedCliVersion ?? 'unknown'}`,
          `Version compatible: ${formatBooleanStatus(host.pocketshellVersionCompatible)}`,
          `Daemon running: ${formatBooleanStatus(host.pocketshellDaemonRunning)}`,
          `Daemon enabled: ${formatBooleanStatus(host.pocketshellDaemonEnabled)}`,
          `tmux installed: ${formatBooleanStatus(host.tmuxInstalled)}`,
          `Last bootstrap check: ${formatTimestamp(host.lastBootstrapAt)}`,
          `Last PocketShell detection: ${formatTimestamp(host.pocketshellLastDetectedAt)}`,
        ],
        actions: [
          { label: 'Check Bootstrap', command: 'pocketshell.bootstrap.status', args: [host.id] },
          { label: 'Install/Upgrade', command: 'pocketshell.bootstrap.install', args: [host.id] },
        ],
      },
      {
        title: 'Recent Sessions',
        rows: [],
        empty: 'Recent session data is not available yet. Use tmux sessions to list what is running on this host.',
        actions: [
          { label: 'List tmux Sessions', command: 'pocketshell.tmux.list', args: [host.id] },
          { label: 'Create tmux Session', command: 'pocketshell.tmux.new', args: [host.id] },
        ],
      },
      {
        title: 'Watched Folders',
        rows: (options.watchedFolders ?? []).map((folder) => folderRow(host.id, folder)),
        empty: 'No watched folders are configured in this desktop workspace yet. Add a folder or discover common remote roots.',
        actions: [
          { label: 'Add Folder', command: 'pocketshell.watchedFolders.add', args: [host.id] },
          { label: 'Manage Folders', command: 'pocketshell.watchedFolders.manage', args: [host.id] },
          { label: 'Discover Roots', command: 'pocketshell.watchedFolders.discover', args: [host.id] },
        ],
      },
      {
        title: 'Workspace Actions',
        rows: [
          'Use these entry points for per-host files, usage, environment, git, and settings workflows.',
        ],
        actions: [
          { label: 'Git Status', command: 'pocketshell.git.status', args: [host.id] },
          { label: 'Environment', command: 'pocketshell.env.list', args: [host.id] },
          { label: 'Settings', command: 'pocketshell.settings.open', args: [] },
          { label: 'Refresh', command: 'pocketshell.hostDetail.open', args: [host.id] },
        ],
      },
    ],
  };
}

function folderRow(hostId: number, folder: HostDetailFolder): HostDetailRow {
  const target = { hostId, folderId: folder.id, path: folder.path };
  return {
    label: folder.label,
    detail: folder.path,
    meta: `${folder.source}${folder.enabled ? '' : ', disabled'}`,
    actions: [
      { label: 'Session', command: 'pocketshell.watchedFolders.openSession', args: [target] },
      { label: 'Files', command: 'pocketshell.files.browse', args: [target] },
      { label: 'Env', command: 'pocketshell.env.list', args: [target] },
      { label: 'Git', command: 'pocketshell.git.status', args: [target] },
      { label: 'History', command: 'pocketshell.git.history', args: [target] },
      { label: 'Repo', command: 'pocketshell.git.branches', args: [target] },
    ],
  };
}

export function renderHostDetailHtml(model: HostDetailModel): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.45;
      margin: 0;
      padding: 24px;
    }
    main {
      max-width: 920px;
    }
    h1, h2 {
      font-weight: 600;
      margin: 0;
    }
    h1 {
      font-size: 26px;
    }
    h2 {
      font-size: 16px;
      margin-top: 28px;
      margin-bottom: 10px;
    }
    .subtitle {
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
    }
    .state {
      display: inline-block;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      margin-top: 14px;
      padding: 4px 8px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 16px;
    }
    a.action {
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-secondaryBackground);
      padding: 6px 10px;
      text-decoration: none;
    }
    a.action.primary {
      background: var(--vscode-button-background);
    }
    a.action:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .section {
      border-top: 1px solid var(--vscode-panel-border);
      margin-top: 24px;
      padding-top: 4px;
    }
    ul {
      margin: 8px 0 0;
      padding-left: 20px;
    }
    li {
      margin: 4px 0;
    }
    .row-detail {
      color: var(--vscode-descriptionForeground);
      margin-left: 6px;
    }
    .row-meta {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      margin-left: 6px;
    }
    .row-actions {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-left: 8px;
    }
    a.row-action {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    a.row-action:hover {
      text-decoration: underline;
    }
    .empty {
      color: var(--vscode-descriptionForeground);
      margin-top: 8px;
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(model.title)}</h1>
    <div class="subtitle">${escapeHtml(model.subtitle)}</div>
    <div class="state">${escapeHtml(model.connectionState)}</div>
    ${renderActions(model.primaryActions)}
    <section class="section">
      <h2>Status</h2>
      ${renderRows(model.statusRows)}
    </section>
    ${model.sections.map(renderSection).join('')}
  </main>
</body>
</html>`;
}

function renderSection(section: HostDetailSection): string {
  const rows = section.rows.length > 0
    ? renderRows(section.rows)
    : `<p class="empty">${escapeHtml(section.empty ?? 'No data available.')}</p>`;
  return `<section class="section">
    <h2>${escapeHtml(section.title)}</h2>
    ${rows}
    ${renderActions(section.actions ?? [])}
  </section>`;
}

function renderRows(rows: Array<string | HostDetailRow>): string {
  return `<ul>${rows.map(renderRow).join('')}</ul>`;
}

function renderRow(row: string | HostDetailRow): string {
  if (typeof row === 'string') {
    return `<li>${escapeHtml(row)}</li>`;
  }
  const detail = row.detail ? `<span class="row-detail">${escapeHtml(row.detail)}</span>` : '';
  const meta = row.meta ? `<span class="row-meta">${escapeHtml(row.meta)}</span>` : '';
  const actions = row.actions && row.actions.length > 0
    ? `<span class="row-actions">${row.actions.map(renderRowAction).join('')}</span>`
    : '';
  return `<li><strong>${escapeHtml(row.label)}</strong>${detail}${meta}${actions}</li>`;
}

function renderRowAction(action: HostDetailAction): string {
  const href = `command:${action.command}?${encodeURIComponent(JSON.stringify(action.args))}`;
  return `<a class="row-action" href="${href}">${escapeHtml(action.label)}</a>`;
}

function renderActions(actions: HostDetailAction[]): string {
  if (actions.length === 0) {
    return '';
  }
  return `<div class="actions">${actions.map((action) => {
    const href = `command:${action.command}?${encodeURIComponent(JSON.stringify(action.args))}`;
    const className = action.primary ? 'action primary' : 'action';
    return `<a class="${className}" href="${href}">${escapeHtml(action.label)}</a>`;
  }).join('')}</div>`;
}

function formatInstalled(installed: boolean | null, version: string | null): string {
  if (installed === null) {
    return 'unknown';
  }
  if (!installed) {
    return 'not installed';
  }
  return version ? `installed (${version})` : 'installed';
}

function formatBooleanStatus(value: boolean | null): string {
  if (value === null) {
    return 'unknown';
  }
  return value ? 'yes' : 'no';
}

function formatTimestamp(value: number | null): string {
  if (value === null) {
    return 'never';
  }
  return new Date(value).toISOString();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
