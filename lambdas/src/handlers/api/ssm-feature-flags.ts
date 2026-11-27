import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";

import { ALL_ON, cachedFeatureFlags, type FeatureFlags } from "./feature-flags.ts";

/**
 * The feature flags in one SSM String parameter (ADR-0107), read at most once
 * a minute per container. Without a parameter name everything is on.
 */
export function ssmFeatureFlags(client: SSMClient, capabilities: readonly string[], name = process.env.FEATURE_FLAGS_PARAMETER): FeatureFlags {
  if (!name) return ALL_ON;
  return cachedFeatureFlags(async () => (await client.send(new GetParameterCommand({ Name: name }))).Parameter?.Value ?? "{}", { capabilities });
}
