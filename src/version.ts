// Named import → the bundler inlines only this one field, not the whole package.json.
import { version } from '../package.json';

/** Single source of truth for the version: package.json (inlined at build time). */
export const VERSION: string = version;
