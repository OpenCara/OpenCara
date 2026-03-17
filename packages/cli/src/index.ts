#!/usr/bin/env node

import { Command } from 'commander';
import { getVersion } from '@opencara/shared';
import { loginCommand } from './commands/login.js';
import { agentCommand } from './commands/agent.js';
import { statsCommand } from './commands/stats.js';

const program = new Command()
  .name('opencara')
  .description('OpenCara — distributed AI code review agent')
  .version(getVersion());

program.addCommand(loginCommand);
program.addCommand(agentCommand);
program.addCommand(statsCommand);

program.parse();
