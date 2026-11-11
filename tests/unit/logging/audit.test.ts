import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditEntry, AuditLog } from '../../../src/logging/AuditLog.js';
import { JsonlAuditLog, shorten } from '../../../src/logging/JsonlAuditLog.js';
import { PolicyPermissionGate } from '../../../src/permissions/PolicyPermissionGate.js';
import { ReadFileTool } from '../../../src/tools/fs/ReadFileTool.js';
import { WriteFileTool } from '../../../src/tools/fs/WriteFileTool.js';
import { ToolExecutor } from '../../../src/tools/ToolExecutor.js';
import { ToolRegistry } from '../../../src/tools/ToolRegistry.js';
import { CheckpointStore } from '../../../src/workspace/CheckpointStore.js';
import { FileReadTracker } from '../../../src/workspace/FileReadTracker.js';
import { Workspace } from '../../../src/workspace/Workspace.js';
import { WorkspaceWriter } from '../../../src/workspace/WorkspaceWriter.js';
import { FakeApprover } from '../../helpers/FakeApprover.js';
import { createTempDir, removeTempDir } from '../../helpers/tempWorkspace.js';

let root: string;
beforeEach(() => {
  root = createTempDir({ 'a.txt': 'hello' });
});
afterEach(() => removeTempDir(root));

class MemoryAudit implements AuditLog {
  readonly entries: AuditEntry[] = [];
  record(entry: AuditEntry) {
    this.entries.push(entry);
  }
}

describe('ToolExecutor + audit log', () => {
  it('records every call with its outcome: ok, failed, denied', async () => {
    const workspace = Workspace.open(root);
    const reads = new FileReadTracker();
    const writer = new WorkspaceWriter(workspace, new CheckpointStore(), reads);
    const audit = new MemoryAudit();
    const executor = new ToolExecutor(
      new ToolRegistry().register(new ReadFileTool(reads)).register(new WriteFileTool(writer)),
      workspace,
      {
        gate: new PolicyPermissionGate(new FakeApprover([{ decision: 'deny' }]), 'ask'),
        audit,
        sessionId: 's1',
      },
    );
    const signal = new AbortController().signal;
    await executor.run({ id: '1', name: 'read_file', arguments: '{"path":"a.txt"}' }, signal);
    await executor.run({ id: '2', name: 'read_file', arguments: '{"path":"nope.txt"}' }, signal);
    await executor.run(
      { id: '3', name: 'write_file', arguments: '{"path":"b.txt","content":"x"}' },
      signal,
    );

    expect(audit.entries.map((e) => [e.tool, e.label, e.outcome])).toEqual([
      ['read_file', 'a.txt', 'ok'],
      ['read_file', 'nope.txt', 'failed'],
      ['write_file', 'b.txt', 'denied'],
    ]);
    expect(audit.entries[0]).toMatchObject({ session: 's1', args: { path: 'a.txt' } });
  });
});

describe('JsonlAuditLog', () => {
  it('appends JSON lines to .heph/logs/audit-<date>.jsonl and git-ignores the logs', () => {
    const log = new JsonlAuditLog(root);
    const entry: AuditEntry = {
      time: 't',
      session: 's',
      tool: 'read_file',
      label: 'a',
      args: {},
      outcome: 'ok',
      durationMs: 1,
    };
    log.record(entry);
    log.record({ ...entry, outcome: 'denied' });

    const lines = fs
      .readFileSync(log.file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.outcome)).toEqual(['ok', 'denied']);
    expect(path.basename(log.file)).toMatch(/^audit-\d{4}-\d{2}-\d{2}\.jsonl$/);
    expect(fs.readFileSync(path.join(root, '.heph', '.gitignore'), 'utf8')).toContain('logs/');
  });

  it('shortens long strings (e.g. whole file contents)', () => {
    expect(shorten({ content: 'x'.repeat(2000), n: 1 })).toEqual({
      content: `${'x'.repeat(500)}… [2000 chars]`,
      n: 1,
    });
  });

  it('never throws: a failing log disables itself and reports once', () => {
    const file = path.join(root, 'blocker');
    fs.writeFileSync(file, ''); // a FILE where the .heph folder should be → mkdir fails
    const errors: unknown[] = [];
    const log = new JsonlAuditLog(file, (e) => errors.push(e));
    const entry: AuditEntry = {
      time: 't',
      session: 's',
      tool: 'x',
      label: '',
      args: {},
      outcome: 'ok',
      durationMs: 0,
    };
    expect(() => {
      log.record(entry);
      log.record(entry);
    }).not.toThrow();
    expect(errors).toHaveLength(1);
  });
});
