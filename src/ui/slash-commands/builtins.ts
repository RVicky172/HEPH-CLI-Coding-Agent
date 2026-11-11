import chalk from 'chalk';
import {
  isPermissionMode,
  MODE_DESCRIPTIONS,
  PERMISSION_MODES,
} from '../../permissions/PermissionMode.js';
import { formatTokens } from '../render/TurnRenderer.js';
import { modeLabel } from '../TerminalUI.js';
import type { SlashCommand, SlashCommandResult } from './SlashCommand.js';

export const helpCommand: SlashCommand = {
  name: 'help',
  aliases: ['?'],
  description: 'show available commands',
  run(_args, { output, commands }) {
    const rows = commands.map((c) => {
      const label = `/${c.name}${c.usage ? ` ${c.usage}` : ''}`;
      return `  ${chalk.cyan(label.padEnd(18))} ${c.description}`;
    });
    output.info(
      ['Commands:', ...rows, '', chalk.dim('  Ctrl+C interrupts a running answer.')].join('\n'),
    );
    return 'continue';
  },
};

export const clearCommand: SlashCommand = {
  name: 'clear',
  aliases: ['new'],
  description: 'forget the conversation and start fresh',
  run(_args, { agent, output }) {
    agent.reset();
    output.info(chalk.dim('Conversation cleared.'));
    return 'continue';
  },
};

export const modelCommand: SlashCommand = {
  name: 'model',
  usage: '[id]',
  description: 'show the current model, or switch to another one',
  run(args, { agent, output }) {
    if (!args) {
      output.info(
        `Model: ${chalk.cyan(agent.model)} ${chalk.dim(`(profile ${agent.providerName})`)}`,
      );
    } else {
      agent.setModel(args);
      output.info(`Switched model to ${chalk.cyan(args)}.`);
    }
    return 'continue';
  },
};

export const modeCommand: SlashCommand = {
  name: 'mode',
  usage: '[mode]',
  description: 'show or change what heph may do without asking',
  run(args, { session, output, agent }) {
    if (!args) {
      const rows = PERMISSION_MODES.map(
        (m) =>
          `  ${m === session.mode ? chalk.cyan('●') : ' '} ${modeLabel(m)}${' '.repeat(10 - m.length)} ${chalk.dim(MODE_DESCRIPTIONS[m])}`,
      );
      const grants = session.sessionGrants.length
        ? `\n  ${chalk.dim('always allowed this session:')} ${session.sessionGrants.join(', ')}`
        : '';
      output.info(['Permission mode:', ...rows, grants].join('\n'));
      return 'continue';
    }
    if (!isPermissionMode(args)) {
      output.warn(`Unknown mode "${args}". Choose one of: ${PERMISSION_MODES.join(', ')}.`);
      return 'continue';
    }
    session.setMode(args);
    if (args === 'ask' || args === 'read-only') session.clearSessionGrants(); // stricter = forget "always"
    agent.addNote(
      `The user switched the permission mode to "${args}" (${MODE_DESCRIPTIONS[args]}).`,
    );
    output.info(`Mode is now ${modeLabel(args)}: ${MODE_DESCRIPTIONS[args]}.`);
    if (args === 'full-auto')
      output.warn(
        'full-auto: heph will not ask before changes. Use it only in throw-away folders.',
      );
    return 'continue';
  },
};

export const undoCommand: SlashCommand = {
  name: 'undo',
  description: "revert heph's most recent file change",
  async run(_args, { session, output, agent }): Promise<SlashCommandResult> {
    const result = await session.undo();
    if (!result) {
      output.info(chalk.dim('Nothing to undo.'));
      return 'continue';
    }
    agent.addNote(`The user ran /undo: ${result}. Your earlier change to that file is gone.`);
    output.info(`${chalk.green('↶')} ${result}`);
    return 'continue';
  },
};

export const contextCommand: SlashCommand = {
  name: 'context',
  aliases: ['ctx'],
  description: 'show how full the context window is and what uses it',
  run(_args, { agent, output }) {
    const r = agent.contextReport();
    if (!r) {
      output.info(chalk.dim('Context tracking is not enabled.'));
      return 'continue';
    }
    const used = r.system + r.tools + r.conversation;
    const pct = used / r.limit;
    const width = 40;
    const filled = Math.min(width, Math.round(pct * width));
    const color = pct >= 0.85 ? chalk.red : pct >= 0.6 ? chalk.yellow : chalk.green;
    const row = (label: string, tokens: number) =>
      `  ${label.padEnd(16)} ${formatTokens(tokens).padStart(6)} ${chalk.dim(`(${Math.round((tokens / r.limit) * 100)}%)`)}`;
    output.info(
      [
        `Context: ${color(`${Math.round(pct * 100)}%`)} of ${formatTokens(r.limit)} tokens ${chalk.dim(`(window ${formatTokens(r.window)}, the rest is kept for the answer)`)}`,
        `  ${color('█'.repeat(filled))}${chalk.dim('░'.repeat(width - filled))}`,
        row('system prompt', r.system),
        row('tool schemas', r.tools),
        row(`conversation`, r.conversation) + chalk.dim(`  ${r.messages} messages`),
        '',
        chalk.dim('  At 75% heph summarises older turns automatically. /compact does it now.'),
      ].join('\n'),
    );
    return 'continue';
  },
};

export const compactCommand: SlashCommand = {
  name: 'compact',
  description: 'summarise the conversation so far to free up context',
  async run(_args, { agent, output }): Promise<SlashCommandResult> {
    output.info(chalk.dim('Summarising the conversation…'));
    try {
      const result = await agent.compactNow(new AbortController().signal);
      if (!result) {
        output.info(chalk.dim('Nothing to compact yet (need at least two turns).'));
      } else {
        output.info(
          `${chalk.hex('#ffb37a')('✻')} Compacted ${result.turns} turn${result.turns === 1 ? '' : 's'}: ${formatTokens(result.tokensBefore)} → ${formatTokens(result.tokensAfter)} tokens.`,
        );
      }
    } catch (error) {
      output.error(error);
    }
    return 'continue';
  },
};

export const exitCommand: SlashCommand = {
  name: 'exit',
  aliases: ['quit', 'q'],
  description: 'quit heph',
  run: () => 'exit',
};

export const BUILTIN_COMMANDS: readonly SlashCommand[] = [
  helpCommand,
  modeCommand,
  undoCommand,
  contextCommand,
  compactCommand,
  clearCommand,
  modelCommand,
  exitCommand,
];
