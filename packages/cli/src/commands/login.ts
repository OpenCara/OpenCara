import { Command } from 'commander';
import type { DeviceFlowResponse, DeviceTokenResponse } from '@opencrust/shared';
import { loadConfig, saveConfig } from '../config.js';
import { ApiClient } from '../http.js';
import { sleep } from '../reconnect.js';

export const loginCommand = new Command('login')
  .description('Authenticate with GitHub via device flow')
  .action(async () => {
    const config = loadConfig();
    const client = new ApiClient(config.platformUrl);

    let flow: DeviceFlowResponse;
    try {
      flow = await client.post<DeviceFlowResponse>('/auth/device');
    } catch (err) {
      console.error(
        'Failed to start device flow:',
        err instanceof Error ? err.message : err,
      );
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
        tokenRes = await client.post<DeviceTokenResponse>(
          '/auth/device/token',
          { deviceCode: flow.deviceCode },
        );
      } catch (err) {
        console.error(
          'Polling error:',
          err instanceof Error ? err.message : err,
        );
        continue;
      }

      if (tokenRes.status === 'pending') {
        process.stdout.write('.');
        continue;
      }

      if (tokenRes.status === 'expired') {
        console.error('\nDevice code expired. Please run `opencrust login` again.');
        process.exit(1);
      }

      if (tokenRes.status === 'complete') {
        config.apiKey = tokenRes.apiKey;
        saveConfig(config);
        console.log('\nLogged in successfully. API key saved to ~/.opencrust/config.yml');
        return;
      }
    }

    console.error('\nDevice code expired. Please run `opencrust login` again.');
    process.exit(1);
  });
