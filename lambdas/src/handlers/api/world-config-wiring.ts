import { awsControlPlaneSources } from "../../control-plane/aws.ts";
import { awsWorldRecords } from "../../control-plane/aws-world-records.ts";
import { awsConfigFileStore } from "../../control-plane/s3-world-config.ts";
import { worldConfigFeature } from "./world-config.ts";

// A world's config files as deployed: their ports bound to the AWS adapters.
export const deployedWorldConfig = worldConfigFeature({
  sources: awsControlPlaneSources,
  worlds: awsWorldRecords,
  files: awsConfigFileStore,
  now: () => new Date(),
});
