#!/usr/bin/env node

import { Command } from 'commander';
import { agentCommand, startAgentRouter } from './commands/agent.js';
import { statusCommand } from './commands/status.js';

declare const __CLI_VERSION__: string;

const program = new Command()
  .name('opencara')
  .description('OpenCara — distributed AI code review agent')
  .version(__CLI_VERSION__);

program.addCommand(agentCommand);
program.addCommand(statusCommand);

// Default: run agent start in router mode when no subcommand is given
program.action(() => {
  startAgentRouter();
});

program.parse();
