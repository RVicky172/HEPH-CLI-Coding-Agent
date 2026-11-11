import type { ApprovalRequest } from '../../src/permissions/ApprovalRequest.js';
import type { ApprovalAnswer, Approver } from '../../src/permissions/Approver.js';

/** A scripted human: answers approval questions in order, and records what it was shown. */
export class FakeApprover implements Approver {
  readonly asked: ApprovalRequest[] = [];
  readonly shown: { request: ApprovalRequest; note: string }[] = [];
  readonly #answers: ApprovalAnswer[];

  constructor(answers: ApprovalAnswer[] = []) {
    this.#answers = [...answers];
  }

  async ask(request: ApprovalRequest): Promise<ApprovalAnswer> {
    this.asked.push(request);
    const answer = this.#answers.shift();
    if (!answer) throw new Error('FakeApprover: asked more often than scripted');
    return answer;
  }

  show(request: ApprovalRequest, note: string): void {
    this.shown.push({ request, note });
  }
}
