import { createProgram, type CliActions } from './program.js';

// Entry point for the `heph` binary (built to dist/cli.js).
// Keep this file tiny: build the program, run it, report fatal errors.
//
// The container (and with it the openai SDK, chalk…) is loaded lazily, so
// `heph --version` / `--help` stay instant.
const container = () => import('../container.js').then((m) => m.cliActions);
const actions: CliActions = {
  chat: async (o) => (await container()).chat(o),
  models: async (o) => (await container()).models(o),
  run: async (task, o) => (await container()).run(task, o),
  init: async (o) => (await container()).init(o),
  config: async (o) => (await container()).config(o),
  sessions: async (o) => (await container()).sessions(o),
};

try {
  await createProgram(actions).parseAsync(process.argv);
} catch (error) {
  const { formatError } = await import('../ui/formatError.js');
  console.error(formatError(error));
  process.exitCode = 1;
}
