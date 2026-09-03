import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEEP_NEWEST,
  DEFAULT_RETENTION_POLICY,
  buildDeleteCommands,
  parseDeletedCount,
  planPrune,
  type AttachmentRetentionPolicy,
  type PrunableEntry,
} from '@main/attachments/AttachmentRetentionPolicy';

/** Ported from the Android AttachmentRetentionPolicyTest. */

const NOW = 10_000_000_000;
const hours = (n: number): number => n * 60 * 60 * 1_000;
const days = (n: number): number => hours(24 * n);

const file = (name: string, modifiedMillis: number): PrunableEntry => ({
  name,
  type: 'file',
  modifyTime: modifiedMillis,
});

const policy = (over: Partial<AttachmentRetentionPolicy>): AttachmentRetentionPolicy => ({
  ...DEFAULT_RETENTION_POLICY,
  ...over,
});

describe('planPrune', () => {
  it('deletes expired files but keeps recent ones', () => {
    const plan = planPrune(
      [file('fresh.txt', NOW - hours(2)), file('expired.txt', NOW - days(8))],
      NOW,
    );
    expect(plan.delete.map((a) => a.name)).toEqual(['expired.txt']);
  });

  it('lets the newest-safety window win over the cap', () => {
    const plan = planPrune(
      [
        file('a.txt', NOW - hours(1)),
        file('b.txt', NOW - hours(2)),
        file('c.txt', NOW - hours(3)),
        file('d.txt', NOW - hours(4)),
      ],
      NOW,
      policy({ keepNewest: 2, protectNewestMillis: days(1) }),
    );
    expect(plan.delete).toEqual([]);
  });

  it('deletes only files outside the newest window once they leave the safety window', () => {
    const plan = planPrune(
      [
        file('newest.txt', NOW - days(2)),
        file('second.txt', NOW - days(3)),
        file('third.txt', NOW - days(4)),
      ],
      NOW,
      policy({ keepNewest: 2, protectNewestMillis: days(1) }),
    );
    expect(plan.delete.map((a) => a.name)).toEqual(['third.txt']);
  });

  it('ignores directories and entries with no usable mtime', () => {
    const plan = planPrune(
      [
        { name: 'subdir', type: 'dir', modifyTime: NOW - days(30) },
        { name: 'nomtime.txt', type: 'file', modifyTime: 0 },
        file('expired.txt', NOW - days(30)),
      ],
      NOW,
    );
    expect(plan.delete.map((a) => a.name)).toEqual(['expired.txt']);
  });

  it('ranks newest-first and breaks ties by name', () => {
    const same = NOW - days(3);
    const plan = planPrune(
      [file('b.txt', same), file('a.txt', same), file('c.txt', NOW - days(2))],
      NOW,
      policy({ keepNewest: 2, protectNewestMillis: days(1) }),
    );
    // c (newest) then a then b — only b falls past the cap of 2.
    expect(plan.delete.map((a) => a.name)).toEqual(['b.txt']);
  });

  it('keeps the newest 20 by default', () => {
    // 30 files, all past the 24h protect window but inside the 7d TTL, so
    // only the keep-newest cap applies.
    const entries = Array.from({ length: 30 }, (_v, i) =>
      file(`f${String(i).padStart(2, '0')}.png`, NOW - days(2) - i * hours(1)),
    );
    const plan = planPrune(entries, NOW);
    expect(plan.delete).toHaveLength(30 - DEFAULT_KEEP_NEWEST);
    expect(plan.delete.map((a) => a.name)).toEqual(
      entries.slice(DEFAULT_KEEP_NEWEST).map((e) => e.name),
    );
  });

  it('rejects a nonsensical policy', () => {
    expect(() => planPrune([], NOW, policy({ keepNewest: 0 }))).toThrow(/keepNewest/);
    expect(() => planPrune([], NOW, policy({ ttlMillis: 0 }))).toThrow(/ttlMillis/);
  });
});

describe('buildDeleteCommands', () => {
  const dir = '.pocketshell/attachments/main';

  it('emits a tilde-expandable rm with a receipt', () => {
    // Quoting goes through src/shared/shellQuote.ts, the one escape the rest
    // of the repo standardizes on — it emits `$HOME` unquoted where the old
    // local copy kept `~`. Any POSIX shell expands the two identically.
    expect(buildDeleteCommands(dir, ['a.png', 'b.png'], false, 50)).toEqual([
      `rm -f -- $HOME/'${dir}/a.png' $HOME/'${dir}/b.png' && printf 'deleted\\t2\\n'`,
    ]);
  });

  it('chunks into batches', () => {
    const names = Array.from({ length: 5 }, (_v, i) => `f${i}.png`);
    const commands = buildDeleteCommands(dir, names, false, 2);
    expect(commands).toHaveLength(3);
    expect(commands[2]).toContain("deleted\\t1\\n");
  });

  it('single-quotes names containing shell metacharacters', () => {
    const [command] = buildDeleteCommands(dir, ["it's $(rm -rf ~).png"], false, 50);
    expect(command).toContain(`$HOME/'${dir}/it'\\''s $(rm -rf ~).png'`);
  });

  it('drops names that could steer rm outside the directory', () => {
    expect(buildDeleteCommands(dir, ['../../.ssh/id_rsa', '.', '..', '  '], false, 50)).toEqual(
      [],
    );
  });

  it('emits a printf instead of rm in dry-run mode', () => {
    const [command] = buildDeleteCommands(dir, ['a.png'], true, 50);
    expect(command).toContain('would-delete');
    expect(command).not.toContain('rm ');
  });

  it('returns nothing for an empty name list', () => {
    expect(buildDeleteCommands(dir, [], false, 50)).toEqual([]);
    expect(() => buildDeleteCommands(dir, ['a.png'], false, 0)).toThrow(/batchSize/);
  });
});

describe('parseDeletedCount', () => {
  it('sums the receipts', () => {
    expect(parseDeletedCount('deleted\t50\ndeleted\t3\n')).toBe(53);
  });

  it('ignores unrelated output', () => {
    expect(parseDeletedCount('rm: cannot remove\nnoise\n')).toBe(0);
    expect(parseDeletedCount('')).toBe(0);
  });
});
