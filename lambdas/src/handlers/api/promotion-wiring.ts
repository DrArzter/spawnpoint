import { awsHostEnvKeys } from "../../control-plane/aws-host-env-keys.ts";
import { awsControlPlaneSources } from "../../control-plane/aws.ts";
import { awsSessionMachines } from "../../control-plane/aws-session-machines.ts";
import { awsWorldRecords } from "../../control-plane/aws-world-records.ts";
import { promotionFeature } from "./promotion.ts";

// The promotion as deployed: its ports bound to the AWS adapters.
export const deployedPromotion = promotionFeature({ sources: awsControlPlaneSources, machines: awsSessionMachines, worlds: awsWorldRecords, hostEnv: awsHostEnvKeys });
