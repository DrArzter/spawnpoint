import { awsControlPlaneSources } from "../../control-plane/aws.ts";
import { startPresetBuild } from "../../control-plane/aws-release-builds.ts";
import { releaseRetirement } from "../../control-plane/aws-release-retirement.ts";
import { awsReleaseLinks } from "../../control-plane/s3-release-links.ts";
import { releasesFeature } from "./releases.ts";

// The releases as deployed: their ports bound to the AWS adapters. The
// sources are the shared object, read at request time.
export const deployedReleases = releasesFeature({
  sources: awsControlPlaneSources,
  links: awsReleaseLinks((gameId, presetId, release) =>
    awsControlPlaneSources.readReleaseManifest?.(gameId, presetId, release) ?? Promise.resolve(null)),
  startBuild: startPresetBuild,
  retirement: releaseRetirement,
});
