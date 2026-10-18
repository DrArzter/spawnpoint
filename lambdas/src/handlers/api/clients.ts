import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { SSMClient } from "@aws-sdk/client-ssm";

// Reused across invocations. Client construction neither reads feature
// configuration nor fetches credentials/secrets from AWS.
export const document = DynamoDBDocumentClient.from(new DynamoDBClient({}));
export const events = new EventBridgeClient({});
export const ssm = new SSMClient({});
