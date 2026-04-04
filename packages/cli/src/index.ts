#!/usr/bin/env node

import { Command } from 'commander';
import { agentCommand, startAgentRouter } from './commands/agent.js';
import { authCommand } from './commands/auth.js';
import { dedupCommand } from './commands/dedup.js';
import { statusCommand } from './commands/status.js';

declare const __CLI_VERSION__: string;
declare const __GIT_COMMIT__: string;

const program = new Command()
  .name('opencara')
  .description('OpenCara — distributed AI code review agent')
  .version(`${__CLI_VERSION__} (${__GIT_COMMIT__})`);

program.addCommand(agentCommand);
program.addCommand(authCommand());
program.addCommand(dedupCommand());
program.addCommand(statusCommand);

// Default: run agent start in router mode when no subcommand is given
program.action(() => {
  startAgentRouter();
});

program.parse();
