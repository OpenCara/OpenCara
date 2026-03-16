#!/usr/bin/env node

import { getVersion } from '@opencrust/shared';

export function main(): void {
  console.log(`opencrust v${getVersion()}`);
}

main();
