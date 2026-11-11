import { HephError } from './HephError.js';

export type LLMErrorKind =
  | 'connection' // server not reachable (LM Studio not started, no internet…)
  | 'timeout'
  | 'auth' // bad or missing API key
  | 'not_found' // unknown model or endpoint
  | 'rate_limit'
  | 'bad_request' // e.g. context too long, invalid parameter
  | 'no_models' // server is up but has no chat model loaded
  | 'unknown';

/** A provider-neutral LLM failure. Providers translate their SDK errors into this. */
export class LLMError extends HephError {
  readonly kind: LLMErrorKind;

  constructor(kind: LLMErrorKind, message: string, hint?: string, options?: ErrorOptions) {
    super(message, hint, options);
    this.kind = kind;
  }
}
