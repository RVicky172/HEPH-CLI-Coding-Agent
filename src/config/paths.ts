import path from 'node:path';

/** heph's folder name, both in your home directory and inside a project. */
export const HEPH_DIR = '.heph';
export const CONFIG_FILE = 'config.json';

/** ~/.heph/config.json: your personal settings, including API key setup. */
export function userConfigPath(homeDir: string): string {
  return path.join(homeDir, HEPH_DIR, CONFIG_FILE);
}

/** <project>/.heph/config.json: per-project settings (restricted, see ConfigLoader). */
export function projectConfigPath(cwd: string): string {
  return path.join(cwd, HEPH_DIR, CONFIG_FILE);
}
