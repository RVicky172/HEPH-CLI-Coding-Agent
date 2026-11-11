import { describe, expect, it } from 'vitest';
import type { ApprovalRequest, RiskLevel } from '../../../src/permissions/ApprovalRequest.js';
import { denyAllChangesGate } from '../../../src/permissions/PermissionGate.js';
import { strictness } from '../../../src/permissions/PermissionMode.js';
import { PolicyPermissionGate } from '../../../src/permissions/PolicyPermissionGate.js';
import { FakeApprover } from '../../helpers/FakeApprover.js';

const request = (risk: RiskLevel, toolName = 'edit_file'): ApprovalRequest => ({
  toolName,
  risk,
  label: 'a.ts',
  preview: { kind: 'none' },
});
const signal = new AbortController().signal;

describe('PolicyPermissionGate', () => {
  it('reads are always allowed without asking, in every mode', async () => {
    for (const mode of ['read-only', 'ask', 'auto-edit', 'full-auto'] as const) {
      const approver = new FakeApprover();
      const gate = new PolicyPermissionGate(approver, mode);
      expect(await gate.check(request('read'), signal)).toEqual({ verdict: 'allow' });
      expect(approver.asked).toHaveLength(0);
    }
  });

  it('ask mode: asks the human for every write', async () => {
    const approver = new FakeApprover([{ decision: 'allow' }, { decision: 'allow' }]);
    const gate = new PolicyPermissionGate(approver, 'ask');
    await gate.check(request('write'), signal);
    await gate.check(request('write'), signal);
    expect(approver.asked).toHaveLength(2);
  });

  it('ask mode: "no" denies and tells the model not to retry', async () => {
    const gate = new PolicyPermissionGate(new FakeApprover([{ decision: 'deny' }]), 'ask');
    const decision = await gate.check(request('write'), signal);
    expect(decision).toMatchObject({ verdict: 'deny', summary: 'denied by you' });
    expect(decision.verdict === 'deny' && decision.message).toMatch(/Do not retry/);
  });

  it('"no, with feedback" passes the feedback to the model', async () => {
    const gate = new PolicyPermissionGate(
      new FakeApprover([{ decision: 'deny', feedback: 'use a const instead' }]),
      'ask',
    );
    const decision = await gate.check(request('write'), signal);
    expect(decision.verdict === 'deny' && decision.message).toContain('use a const instead');
  });

  it('"always" allows that tool for the rest of the session (preview still shown)', async () => {
    const approver = new FakeApprover([{ decision: 'allow_session' }]);
    const gate = new PolicyPermissionGate(approver, 'ask');
    await gate.check(request('write', 'edit_file'), signal);
    expect(await gate.check(request('write', 'edit_file'), signal)).toEqual({ verdict: 'allow' });
    expect(approver.asked).toHaveLength(1); // asked only once
    expect(approver.shown).toHaveLength(1); // …but the second change was still displayed
    expect(gate.sessionGrants).toEqual(['edit_file']);
  });

  it('"always" for one tool does not cover a different tool', async () => {
    const approver = new FakeApprover([{ decision: 'allow_session' }, { decision: 'deny' }]);
    const gate = new PolicyPermissionGate(approver, 'ask');
    await gate.check(request('write', 'edit_file'), signal);
    expect((await gate.check(request('write', 'write_file'), signal)).verdict).toBe('deny');
  });

  it('read-only mode: refuses changes WITHOUT asking', async () => {
    const approver = new FakeApprover();
    const gate = new PolicyPermissionGate(approver, 'read-only');
    expect((await gate.check(request('write'), signal)).verdict).toBe('deny');
    expect((await gate.check(request('execute'), signal)).verdict).toBe('deny');
    expect(approver.asked).toHaveLength(0);
  });

  it('auto-edit: writes are auto-approved but SHOWN; execute still asks', async () => {
    const approver = new FakeApprover([{ decision: 'deny' }]);
    const gate = new PolicyPermissionGate(approver, 'auto-edit');
    expect((await gate.check(request('write'), signal)).verdict).toBe('allow');
    expect(approver.shown).toHaveLength(1);
    expect((await gate.check(request('execute'), signal)).verdict).toBe('deny');
    expect(approver.asked).toHaveLength(1);
  });

  it('non-interactive denial explains that nobody could approve', async () => {
    const gate = new PolicyPermissionGate(
      new FakeApprover([{ decision: 'deny', reason: 'non_interactive' }]),
      'ask',
    );
    const decision = await gate.check(request('write'), signal);
    expect(decision).toMatchObject({ verdict: 'deny', summary: 'not applied: no terminal to ask' });
  });

  it('setMode switches behaviour immediately', async () => {
    const approver = new FakeApprover();
    const gate = new PolicyPermissionGate(approver, 'auto-edit');
    gate.setMode('read-only');
    expect((await gate.check(request('write'), signal)).verdict).toBe('deny');
  });
});

describe('reads = "ask" (the product default)', () => {
  const readReq = (label = 'README.md') => ({ ...request('read', 'read_file'), label });

  it('the first read ASKS; "a" then allows every later read silently', async () => {
    const approver = new FakeApprover([{ decision: 'allow_session' }]);
    const gate = new PolicyPermissionGate(approver, 'ask', undefined, 'ask');
    expect((await gate.check(readReq('a.ts'), signal)).verdict).toBe('allow');
    expect((await gate.check(readReq('b.ts'), signal)).verdict).toBe('allow');
    expect((await gate.check({ ...readReq(), toolName: 'grep' }, signal)).verdict).toBe('allow');
    expect(approver.asked).toHaveLength(1);
    expect(approver.shown).toHaveLength(0); // reads aren't echoed: they change nothing
    expect(gate.sessionGrants).toEqual(['all reads this session']);
  });

  it('"y" allows only that one read', async () => {
    const approver = new FakeApprover([{ decision: 'allow' }, { decision: 'deny' }]);
    const gate = new PolicyPermissionGate(approver, 'ask', undefined, 'ask');
    expect((await gate.check(readReq('a.ts'), signal)).verdict).toBe('allow');
    expect((await gate.check(readReq('b.ts'), signal)).verdict).toBe('deny');
  });

  it('"n" refuses the read and tells the model', async () => {
    const gate = new PolicyPermissionGate(
      new FakeApprover([{ decision: 'deny' }]),
      'ask',
      undefined,
      'ask',
    );
    const decision = await gate.check(readReq(), signal);
    expect(decision.verdict === 'deny' && decision.message).toMatch(/^NOT APPLIED/);
  });

  it('read-only mode with reads=ask also asks (exploring still needs consent)', async () => {
    const approver = new FakeApprover([{ decision: 'allow' }]);
    const gate = new PolicyPermissionGate(approver, 'read-only', undefined, 'ask');
    expect((await gate.check(readReq(), signal)).verdict).toBe('allow');
    expect(approver.asked).toHaveLength(1);
  });

  it('auto-edit and full-auto never ask for reads', async () => {
    for (const mode of ['auto-edit', 'full-auto'] as const) {
      const approver = new FakeApprover();
      const gate = new PolicyPermissionGate(approver, mode, undefined, 'ask');
      expect((await gate.check(readReq(), signal)).verdict).toBe('allow');
      expect(approver.asked).toHaveLength(0);
    }
  });
});

describe('safe defaults', () => {
  it('denyAllChangesGate allows reads only', async () => {
    expect((await denyAllChangesGate.check(request('read'), signal)).verdict).toBe('allow');
    expect((await denyAllChangesGate.check(request('write'), signal)).verdict).toBe('deny');
  });

  it('strictness ranks read-only strictest and full-auto loosest', () => {
    expect(strictness('read-only')).toBeGreaterThan(strictness('ask'));
    expect(strictness('ask')).toBeGreaterThan(strictness('auto-edit'));
    expect(strictness('auto-edit')).toBeGreaterThan(strictness('full-auto'));
  });
});
