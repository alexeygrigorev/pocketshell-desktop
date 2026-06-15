import type { AgentType, SessionInfo } from './conversation/types';
import type { SshConnection } from '../ssh/connection/ssh-client';

export interface ActivePaneConversationContext {
  id: string;
  sessionId: string;
  windowId: string;
  tty?: string;
  cwd?: string;
  process?: {
    currentCommand?: string;
    commandLine?: string;
    argv?: string[];
    pid?: number;
    pids?: number[];
  };
}

export interface AttributableConversationSession extends SessionInfo {
  cwd?: string;
  tty?: string;
  pid?: number;
}

export type ConversationAttributionKind = 'match' | 'ambiguous' | 'no-match';

export interface ConversationAttributionResult {
  kind: ConversationAttributionKind;
  paneKey: string;
  dismissed: boolean;
  shouldShowHint: boolean;
  fromCache: boolean;
  agentType?: AgentType;
  session?: AttributableConversationSession;
  candidates: AttributableConversationSession[];
  reason?: string;
}

interface CachedAttribution {
  signature: string;
  result: ConversationAttributionResult;
}

const AGENT_COMMANDS: Record<AgentType, string[]> = {
  claude: ['claude', 'claude-code'],
  codex: ['codex'],
  opencode: ['opencode'],
};

export class ConversationAttributionService {
  private readonly dismissed = new Set<string>();
  private readonly cache = new Map<string, CachedAttribution>();

  attribute(
    pane: ActivePaneConversationContext | undefined,
    sessions: AttributableConversationSession[],
  ): ConversationAttributionResult {
    if (!pane) {
      return this.buildResult('no-match', 'unknown', false, false, [], undefined, 'No active pane');
    }

    const paneKey = conversationPaneKey(pane);
    const signature = attributionSignature(pane, sessions);
    const cached = this.cache.get(paneKey);
    if (cached?.signature === signature) {
      return { ...cached.result, fromCache: true };
    }

    const dismissed = this.dismissed.has(paneKey);
    const agentType = detectAgentTypeFromProcess(pane.process);
    if (!agentType) {
      const result = this.buildResult(
        'no-match',
        paneKey,
        dismissed,
        false,
        [],
        undefined,
        'Active pane command is not a supported agent',
      );
      this.cache.set(paneKey, { signature, result });
      return result;
    }

    const paneCwd = normalizePath(pane.cwd);
    if (!paneCwd) {
      const result = this.buildResult(
        'no-match',
        paneKey,
        dismissed,
        false,
        [],
        agentType,
        'Active pane cwd is unavailable',
      );
      this.cache.set(paneKey, { signature, result });
      return result;
    }

    const candidates = sessions.filter((session) => {
      if (session.agentType !== agentType) {
        return false;
      }
      const panePids = new Set([
        pane.process?.pid,
        ...(pane.process?.pids ?? []),
      ].filter((value): value is number => value !== undefined));
      if (session.pid !== undefined && panePids.size > 0 && !panePids.has(session.pid)) {
        return false;
      }
      if (session.tty !== undefined && pane.tty !== undefined && session.tty !== pane.tty) {
        return false;
      }
      const sessionCwd = normalizePath(session.cwd ?? cwdFromSessionPath(session.path, session.agentType));
      return sessionCwd !== undefined && pathsEqual(sessionCwd, paneCwd);
    });

    let result: ConversationAttributionResult;
    if (candidates.length === 1) {
      result = this.buildResult(
        'match',
        paneKey,
        dismissed,
        !dismissed,
        candidates,
        agentType,
      );
      result.session = candidates[0];
    } else if (candidates.length > 1) {
      result = this.buildResult(
        'ambiguous',
        paneKey,
        dismissed,
        false,
        candidates,
        agentType,
        'Multiple conversation sessions match the active pane',
      );
    } else {
      result = this.buildResult(
        'no-match',
        paneKey,
        dismissed,
        false,
        [],
        agentType,
        'No conversation session matches the active pane cwd and command',
      );
    }

    this.cache.set(paneKey, { signature, result });
    return result;
  }

  dismiss(pane: ActivePaneConversationContext | string): void {
    const paneKey = typeof pane === 'string' ? pane : conversationPaneKey(pane);
    this.dismissed.add(paneKey);
    this.cache.delete(paneKey);
  }

  isDismissed(pane: ActivePaneConversationContext | string): boolean {
    const paneKey = typeof pane === 'string' ? pane : conversationPaneKey(pane);
    return this.dismissed.has(paneKey);
  }

  clear(): void {
    this.dismissed.clear();
    this.cache.clear();
  }

  private buildResult(
    kind: ConversationAttributionKind,
    paneKey: string,
    dismissed: boolean,
    shouldShowHint: boolean,
    candidates: AttributableConversationSession[],
    agentType?: AgentType,
    reason?: string,
  ): ConversationAttributionResult {
    return {
      kind,
      paneKey,
      dismissed,
      shouldShowHint,
      fromCache: false,
      agentType,
      candidates,
      reason,
    };
  }
}

export function conversationPaneKey(pane: ActivePaneConversationContext): string {
  return `${pane.sessionId}:${pane.windowId}:${pane.id}`;
}

export function detectAgentTypeFromCommand(command: string | undefined): AgentType | undefined {
  if (!command) {
    return undefined;
  }
  const tokens = command
    .trim()
    .split(/\s+/)
    .map((token) => basename(token).toLowerCase());

  if (tokens[0] === 'pocketshell' && tokens[1] === 'agent') {
    return agentTypeForCommand(tokens[2]);
  }

  for (const token of tokens) {
    const agentType = agentTypeForCommand(token);
    if (agentType) {
      return agentType;
    }
  }
  return undefined;
}

export function detectAgentTypeFromProcess(
  process: ActivePaneConversationContext['process'] | undefined,
): AgentType | undefined {
  const commandLine = process?.commandLine ?? (process?.argv?.length ? process.argv.join(' ') : undefined);
  return detectAgentTypeFromCommand(commandLine) ?? detectAgentTypeFromCommand(process?.currentCommand);
}

export async function enrichActivePaneConversationContext(
  connection: SshConnection,
  pane: ActivePaneConversationContext | undefined,
): Promise<ActivePaneConversationContext | undefined> {
  if (!pane?.process?.pid) {
    return pane;
  }
  const rows = await readPaneProcessRows(connection, pane.process.pid, pane.tty);
  const commandLine = bestAgentCommandLine(rows) ?? pane.process.commandLine;
  if (!commandLine) {
    return pane;
  }
  return {
    ...pane,
    process: {
      ...pane.process,
      commandLine,
      argv: splitCommandLine(commandLine),
      pids: rows.map((row) => row.pid),
    },
  };
}

export async function enrichConversationSessions(
  connection: SshConnection,
  sessions: AttributableConversationSession[],
  options: ConversationSessionEnrichmentOptions = {},
): Promise<AttributableConversationSession[]> {
  const maxContentFallbackReads = options.maxContentFallbackReads ?? 20;
  const contentFallbackConcurrency = options.contentFallbackConcurrency ?? 4;
  const detectionRows = parseAgentDetectionRows(await readAgentDetectionMetadata(connection));
  const detectionBySession = new Map(
    detectionRows.map((row) => [`${row.agentType}:${row.sessionId}`, row]),
  );

  const enriched = sessions.map((session) => {
    const fromDetection = detectionBySession.get(`${session.agentType}:${session.id}`);
    if (fromDetection) {
      return {
        ...session,
        cwd: session.cwd ?? fromDetection.cwd,
        pid: session.pid ?? fromDetection.pid,
      };
    }
    if (session.cwd) {
      return session;
    }
    return session;
  });

  const fallbackTargets = enriched
    .map((session, index) => ({ session, index }))
    .filter(({ session }) => !session.cwd)
    .slice(0, Math.max(0, maxContentFallbackReads));

  await mapWithConcurrency(
    fallbackTargets,
    Math.max(1, contentFallbackConcurrency),
    async ({ session, index }) => {
      const content = await readSessionHead(connection, session.path);
      const cwd = cwdFromSessionContent(content);
      if (cwd) {
        enriched[index] = { ...session, cwd };
      }
    },
  );

  return enriched;
}

export interface AgentDetectionRow {
  agentType: AgentType;
  sessionId: string;
  pid?: number;
  cwd: string;
}

export interface ConversationSessionEnrichmentOptions {
  maxContentFallbackReads?: number;
  contentFallbackConcurrency?: number;
}

export function enrichSessionsFromAgentDetections(
  sessions: AttributableConversationSession[],
  metadata: string,
): AttributableConversationSession[] {
  const rows = parseAgentDetectionRows(metadata);
  const bySession = new Map(rows.map((row) => [`${row.agentType}:${row.sessionId}`, row]));
  return sessions.map((session) => {
    const row = bySession.get(`${session.agentType}:${session.id}`);
    if (!row) {
      return session;
    }
    return {
      ...session,
      cwd: session.cwd ?? row.cwd,
      pid: session.pid ?? row.pid,
    };
  });
}

export function parseAgentDetectionRows(input: string): AgentDetectionRow[] {
  const rows: AgentDetectionRow[] = [];
  for (const raw of input.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('engine|')) {
      continue;
    }
    const [engine, sessionId, _pane, pidRaw, cwd] = line.split('|');
    const agentType = agentTypeForCommand(engine);
    const normalizedCwd = normalizePath(cwd);
    if (!agentType || !sessionId || !normalizedCwd) {
      continue;
    }
    const pid = Number.parseInt(pidRaw, 10);
    rows.push({
      agentType,
      sessionId,
      pid: Number.isNaN(pid) ? undefined : pid,
      cwd: normalizedCwd,
    });
  }
  return rows;
}

export function cwdFromSessionContent(content: string): string | undefined {
  for (const raw of content.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      const cwd = findCwdField(parsed);
      if (cwd) {
        return cwd;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export interface ProcessEvidenceRow {
  pid: number;
  ppid: number;
  tty?: string;
  commandLine: string;
}

export function parseProcessEvidenceRows(output: string): ProcessEvidenceRow[] {
  const rows: ProcessEvidenceRow[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const [pidRaw, ppidRaw, tty, ...commandParts] = line.split('|');
    const pid = Number.parseInt(pidRaw, 10);
    const ppid = Number.parseInt(ppidRaw, 10);
    const commandLine = commandParts.join('|').trim();
    if (Number.isNaN(pid) || Number.isNaN(ppid) || !commandLine) {
      continue;
    }
    rows.push({
      pid,
      ppid,
      tty: tty || undefined,
      commandLine,
    });
  }
  return rows;
}

export function bestAgentCommandLine(rows: ProcessEvidenceRow[]): string | undefined {
  for (const row of rows) {
    if (detectAgentTypeFromCommand(row.commandLine)) {
      return row.commandLine;
    }
  }
  return undefined;
}

export function cwdFromSessionPath(path: string, agentType: AgentType): string | undefined {
  if (agentType !== 'claude' && agentType !== 'codex' && agentType !== 'opencode') {
    return undefined;
  }

  const marker = '/.claude/projects/';
  const markerIndex = path.indexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }

  const encoded = path.slice(markerIndex + marker.length).split('/')[0];
  if (!encoded.startsWith('-')) {
    return undefined;
  }
  return normalizePath(encoded.replace(/-/g, '/'));
}

function agentTypeForCommand(command: string | undefined): AgentType | undefined {
  if (!command) {
    return undefined;
  }
  for (const [type, commands] of Object.entries(AGENT_COMMANDS)) {
    if (commands.includes(command)) {
      return type as AgentType;
    }
  }
  return undefined;
}

async function readPaneProcessRows(
  connection: SshConnection,
  pid: number,
  tty: string | undefined,
): Promise<ProcessEvidenceRow[]> {
  try {
    const result = await connection.exec(buildPaneProcessEvidenceCommand(pid, tty), 3_000);
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return [];
    }
    return parseProcessEvidenceRows(result.stdout);
  } catch {
    return [];
  }
}

function buildPaneProcessEvidenceCommand(pid: number, tty: string | undefined): string {
  const ttyValue = tty?.replace(/^\/dev\//, '') ?? '';
  return [
    `root=${quoteShellArg(String(pid))}`,
    `pane_tty=${quoteShellArg(ttyValue)}`,
    'queue="$root"',
    'seen=" $root "',
    'depth=0',
    'while [ -n "$queue" ] && [ "$depth" -lt 6 ]; do',
    '  next=""',
    '  for p in $queue; do',
    '    ps -o pid= -o ppid= -o tty= -o args= -p "$p" 2>/dev/null | while read -r cpid cppid ctty cargs; do',
    '      [ -n "$cpid" ] || continue',
    '      if [ -z "$pane_tty" ] || [ "$ctty" = "$pane_tty" ] || [ "$ctty" = "?" ]; then',
    '        printf "%s|%s|%s|%s\\n" "$cpid" "$cppid" "$ctty" "$cargs"',
    '      fi',
    '    done',
    '    for child in $(pgrep -P "$p" 2>/dev/null | head -20); do',
    '      case "$seen" in *" $child "*) ;; *) seen="$seen$child "; next="$next $child" ;; esac',
    '    done',
    '  done',
    '  queue="$next"',
    '  depth=$((depth + 1))',
    'done',
  ].join('; ');
}

async function readAgentDetectionMetadata(connection: SshConnection): Promise<string> {
  try {
    const result = await connection.exec(
      [
        '(pocketshell agent-detections --psv',
        '|| cat "$HOME/.local/state/pocketshell/agent-detections.psv"',
        '|| cat "$HOME/.pocketshell/agent-detections.psv"',
        '|| cat /tmp/pocketshell/agent-detections.psv) 2>/dev/null | head -200 || true',
      ].join(' '),
      3_000,
    );
    return result.stdout;
  } catch {
    return '';
  }
}

async function readSessionHead(connection: SshConnection, path: string): Promise<string> {
  try {
    const result = await connection.exec(`sed -n '1,80p' ${quoteShellArg(path)} 2>/dev/null`, 3_000);
    return result.exitCode === 0 ? result.stdout : '';
  } catch {
    return '';
  }
}

function splitCommandLine(commandLine: string): string[] {
  return commandLine
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function findCwdField(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['cwd', 'currentWorkingDirectory', 'workingDirectory', 'projectCwd', 'project_cwd']) {
    const cwd = normalizePath(typeof record[key] === 'string' ? record[key] : undefined);
    if (cwd) {
      return cwd;
    }
  }
  for (const nested of Object.values(record)) {
    const cwd = findCwdField(nested);
    if (cwd) {
      return cwd;
    }
  }
  return undefined;
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function attributionSignature(
  pane: ActivePaneConversationContext,
  sessions: AttributableConversationSession[],
): string {
  const sessionSig = sessions
    .map((session) => [
      session.agentType,
      session.id,
      session.path,
      session.cwd,
      session.tty,
      session.pid,
      session.modifiedAt,
      session.size,
    ].join('|'))
    .join('\n');
  return [
    pane.id,
    pane.sessionId,
    pane.windowId,
    pane.cwd,
    pane.tty,
    pane.process?.currentCommand,
    normalizeCommandLine(pane.process?.commandLine),
    normalizeArgv(pane.process?.argv),
    pane.process?.pid,
    normalizePids(pane.process?.pids),
    sessionSig,
  ].join('\0');
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(workers);
}

function normalizeCommandLine(commandLine: string | undefined): string {
  return commandLine?.trim().replace(/\s+/g, ' ') ?? '';
}

function normalizeArgv(argv: string[] | undefined): string {
  return (argv ?? []).map((arg) => arg.trim()).join('\x1f');
}

function normalizePids(pids: number[] | undefined): string {
  return [...new Set(pids ?? [])].sort((a, b) => a - b).join(',');
}

function normalizePath(path: string | undefined): string | undefined {
  if (!path) {
    return undefined;
  }
  const trimmed = path.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === '/') {
    return '/';
  }
  return trimmed.replace(/\/+$/, '');
}

function pathsEqual(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

function basename(input: string): string {
  const stripped = input.replace(/^['"]|['"]$/g, '');
  const slash = stripped.lastIndexOf('/');
  return slash >= 0 ? stripped.slice(slash + 1) : stripped;
}
