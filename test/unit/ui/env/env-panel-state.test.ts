import { describe, expect, it } from 'vitest';
import {
  buildEnvPanelModel,
  renderEnvPanelHtml,
} from '../../../../src/ui/env';
import type { EnvVar } from '../../../../src/integrations/env/types';

describe('buildEnvPanelModel', () => {
  it('sorts vars by key and masks secret values', () => {
    const vars: EnvVar[] = [
      { key: 'ZOO', value: 'zebra', isSecret: false },
      { key: 'API_KEY', value: 'shh-secret', isSecret: true },
      { key: 'APP_NAME', value: 'pocketshell', isSecret: false },
    ];
    const model = buildEnvPanelModel({
      scope: '/home/alice/app',
      hostName: 'prod',
      vars,
      copyDestinations: [],
      connected: true,
    });

    expect(model.rows.map((r) => r.key)).toEqual(['API_KEY', 'APP_NAME', 'ZOO']);
    const apiKey = model.rows[0];
    expect(apiKey.isSecret).toBe(true);
    expect(apiKey.maskedValue).toBe('***');
    const zoo = model.rows[2];
    expect(zoo.isSecret).toBe(false);
    expect(zoo.maskedValue).toBe('zebra');
  });

  it('filters copy destinations to enabled folders excluding the current scope', () => {
    const model = buildEnvPanelModel({
      scope: '/home/alice/api',
      hostName: 'prod',
      vars: [],
      copyDestinations: [
        { label: 'api', path: '/home/alice/api', enabled: true },
        { label: 'web', path: '/home/alice/web', enabled: true },
        { label: 'old', path: '/home/alice/old', enabled: false },
      ],
      connected: true,
    });
    expect(model.copyDestinations).toEqual([
      { label: 'web', path: '/home/alice/web' },
    ]);
  });

  it('reports the empty-text when there are no rows', () => {
    const model = buildEnvPanelModel({
      scope: '/home/alice/empty',
      hostName: 'prod',
      vars: [],
      copyDestinations: [],
      connected: true,
    });
    expect(model.rows).toHaveLength(0);
    expect(model.emptyText).toMatch(/No environment variables/);
  });

  it('carries the connection + status banner through', () => {
    const ok = buildEnvPanelModel({
      scope: '/x', hostName: 'h', vars: [], copyDestinations: [], connected: true,
    });
    expect(ok.connected).toBe(true);
    expect(ok.status).toBeUndefined();

    const withStatus = buildEnvPanelModel({
      scope: '/x', hostName: 'h', vars: [], copyDestinations: [], connected: false,
      status: { tone: 'error', message: 'boom' },
    });
    expect(withStatus.connected).toBe(false);
    expect(withStatus.status).toEqual({ tone: 'error', message: 'boom' });
  });
});

describe('renderEnvPanelHtml', () => {
  it('renders the table with masked secret values and the secret tag', () => {
    const model = buildEnvPanelModel({
      scope: '/home/alice/app',
      hostName: 'prod',
      vars: [
        { key: 'API_KEY', value: 'supersecret', isSecret: true },
        { key: 'PORT', value: '8080', isSecret: false },
      ],
      copyDestinations: [{ label: 'web', path: '/home/alice/web', enabled: true }],
      connected: true,
    });
    const html = renderEnvPanelHtml(model, { cspSource: 'https://t', nonce: 'n1' });

    expect(html).toContain('nonce="n1"');
    expect(html).toContain('nonce-n1');
    expect(html).toContain('API_KEY');
    expect(html).toContain('class="secret-tag"');
    // Secret value must NOT appear in the rendered HTML; only the mask.
    expect(html).not.toContain('supersecret');
    expect(html).toContain('***');
    // Non-secret value appears verbatim.
    expect(html).toContain('8080');
    // Copy button is enabled when both rows and destinations exist.
    expect(html).not.toContain('data-action="copy" disabled');
  });

  it('disables the copy button when there are no rows or no destinations', () => {
    const empty = buildEnvPanelModel({
      scope: '/x', hostName: 'h', vars: [], copyDestinations: [{ label: 'w', path: '/w', enabled: true }], connected: true,
    });
    expect(renderEnvPanelHtml(empty, {})).toContain('data-action="copy" disabled');

    const noDest = buildEnvPanelModel({
      scope: '/x', hostName: 'h',
      vars: [{ key: 'K', value: 'v', isSecret: false }],
      copyDestinations: [], connected: true,
    });
    expect(renderEnvPanelHtml(noDest, {})).toContain('data-action="copy" disabled');
  });

  it('renders the empty state instead of a table when there are no vars', () => {
    const model = buildEnvPanelModel({
      scope: '/x', hostName: 'h', vars: [], copyDestinations: [], connected: true,
    });
    const html = renderEnvPanelHtml(model, {});
    expect(html).toContain('No environment variables');
    expect(html).not.toContain('<table>');
  });

  it('shows the disconnected banner when connected is false', () => {
    const model = buildEnvPanelModel({
      scope: '/x', hostName: 'h', vars: [], copyDestinations: [], connected: false,
    });
    expect(renderEnvPanelHtml(model, {})).toContain('disconnected');
  });

  it('escapes values to prevent HTML injection', () => {
    const model = buildEnvPanelModel({
      scope: '/x',
      hostName: 'h',
      vars: [{ key: '<img>', value: '<script>alert(1)</script>', isSecret: false }],
      copyDestinations: [],
      connected: true,
    });
    const html = renderEnvPanelHtml(model, {});
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;img&gt;');
  });
});
