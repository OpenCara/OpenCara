#!/usr/bin/env node

import { Command } from 'commander';
import { getVersion } from '@opencrust/shared';
import { loginCommand } from './commands/login.js';
import { agentCommand } from './commands/agent.js';

const program = new Command()
  .name('opencrust')
  .description('OpenCrust — distributed AI code review agent')
  .version(getVersion());

program.addCommand(loginCommand);
program.addCommand(agentCommand);

program.parse();
