import { Command } from 'commander';
import * as readline from 'node:readline';
import type {
  DeviceFlowResponse,
  DeviceTokenResponse,
  LinkAccountResponse,
} from '@opencara/shared';
import { loadConfig, saveConfig, removeAnonymousAgent } from '../config.js';
import { ApiClient } from '../http.js';
import { sleep } from '../reconnect.js';

function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === '' || normalized === 'y' || normalized === 'yes');
    });
  });
}

export { promptYesNo };

export const loginCommand = new Command('login')
  .description('Authenticate with GitHub via device flow')
  .action(async () => {
    const config = loadConfig();
    const client = new ApiClient(config.platformUrl);

    let flow: DeviceFlowResponse;
    try {
      flow = await client.post<DeviceFlowResponse>('/auth/device');
    } catch (err) {
      console.error('Failed to start device flow:', err instanceof Error ? err.message : err);
      process.exit(1);
    }

    console.log();
    console.log('To sign in, open this URL in your browser:');
    console.log(`  ${flow.verificationUri}`);
    console.log();
    console.log(`And enter this code: ${flow.userCode}`);
    console.log();
    console.log('Waiting for authorization...');

    const intervalMs = flow.interval * 1000;
    const deadline = Date.now() + flow.expiresIn * 1000;

    while (Date.now() < deadline) {
      await sleep(intervalMs);

      let tokenRes: DeviceTokenResponse;
      try {
        tokenRes = await client.post<DeviceTokenResponse>('/auth/device/token', {
          deviceCode: flow.deviceCode,
        });
      } catch (err) {
        console.error('Polling error:', err instanceof Error ? err.message : err);
        continue;
      }

      if (tokenRes.status === 'pending') {
        process.stdout.write('.');
        continue;
      }

      if (tokenRes.status === 'expired') {
        console.error('\nDevice code expired. Please run `opencara login` again.');
        process.exit(1);
      }

      if (tokenRes.status === 'complete') {
        config.apiKey = tokenRes.apiKey;
        saveConfig(config);
        console.log('\nLogged in successfully. API key saved to ~/.opencara/config.yml');

        // Offer to link anonymous agents (only in interactive terminals)
        if (config.anonymousAgents.length > 0 && process.stdin.isTTY) {
          console.log();
          console.log(`Found ${config.anonymousAgents.length} anonymous agent(s):`);
          for (const anon of config.anonymousAgents) {
            console.log(`  - ${anon.agentId} (${anon.model} / ${anon.tool})`);
          }

          const shouldLink = await promptYesNo('Link to your GitHub account? [Y/n] ');
          if (shouldLink) {
            const authedClient = new ApiClient(config.platformUrl, tokenRes.apiKey);
            let linkedCount = 0;
            const toRemove: string[] = [];

            for (const anon of config.anonymousAgents) {
              try {
                await authedClient.post<LinkAccountResponse>('/api/account/link', {
                  anonymousApiKey: anon.apiKey,
                });
                toRemove.push(anon.agentId);
                linkedCount++;
              } catch (err) {
                console.error(
                  `Failed to link agent ${anon.agentId}:`,
                  err instanceof Error ? err.message : err,
                );
              }
            }

            for (const id of toRemove) {
              removeAnonymousAgent(config, id);
            }
            saveConfig(config);

            if (linkedCount > 0) {
              console.log(`Linked ${linkedCount} agent(s) to your account.`);
            }
          }
        }

        return;
      }
    }

    console.error('\nDevice code expired. Please run `opencara login` again.');
    process.exit(1);
  });
