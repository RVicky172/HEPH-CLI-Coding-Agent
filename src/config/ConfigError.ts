import { HephError } from '../core/errors/HephError.js';

/** A problem with the user's configuration (bad JSON, unknown profile, missing key…). */
export class ConfigError extends HephError {}
