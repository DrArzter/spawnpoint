import { awsControlPlaneSources } from "../../control-plane/aws.ts";
import { awsHostDeletion } from "../../control-plane/aws-host-deletion.ts";
import { hostsFeature } from "./hosts.ts";

// Hosts as deployed: their ports bound to the AWS adapters.
export const deployedHosts = hostsFeature({ sources: awsControlPlaneSources, deletion: awsHostDeletion });
