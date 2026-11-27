import { GetParametersByPathCommand, SSMClient } from "@aws-sdk/client-ssm";

import type { HostEnvKeys } from "./launch-preflight.ts";

/** Where a host's .env comes from (server/user-data-fleet.sh.tftpl, render-host-env.sh). */
export const HOST_ENV_PATH = "/spawnpoint/host/env";

// Names only: without decryption a SecureString's value stays ciphertext, and
// the role holds no kms:Decrypt. The value is dropped here and never logged.
export function ssmHostEnvKeys(ssm: SSMClient): HostEnvKeys {
  return {
    list: async () => {
      const keys: string[] = [];
      let nextToken: string | undefined;
      do {
        const page = await ssm.send(new GetParametersByPathCommand({ Path: HOST_ENV_PATH, Recursive: false, WithDecryption: false, NextToken: nextToken }));
        for (const parameter of page.Parameters ?? []) {
          if (parameter.Name) keys.push(parameter.Name.slice(parameter.Name.lastIndexOf("/") + 1));
        }
        nextToken = page.NextToken;
      } while (nextToken);
      return keys;
    },
  };
}

export const awsHostEnvKeys: HostEnvKeys = ssmHostEnvKeys(new SSMClient({}));
