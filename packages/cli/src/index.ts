#!/usr/bin/env node

import { Command } from 'commander';
import { loginCommand } from './commands/login.js';
import { agentCommand } from './commands/agent.js';
import { statsCommand } from './commands/stats.js';

declare const __CLI_VERSION__: string;

const program = new Command()
  .name('opencara')
  .description('OpenCara — distributed AI code review agent')
  .version(__CLI_VERSION__);

program.addCommand(loginCommand);
program.addCommand(agentCommand);
program.addCommand(statsCommand);

program.parse();
