import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { ReleaseRefs } from "../control-plane/release-refs.ts";
import { runCommand } from "./release-writer-cli.ts";
import { s3ObjectPort } from "./s3-object-port.ts";

// Entry of the bundle (no top-level await: the bundle is CommonJS) that CodeBuild runs (tools/release-writer.cjs).
// maxAttempts is 1 on S3: the port retries itself, with a fresh stream each time.
void runCommand(process.argv.slice(2), process.env, ({ bucket, table }) => ({
  port: s3ObjectPort(new S3Client({ maxAttempts: 1, requestChecksumCalculation: "WHEN_REQUIRED" }), bucket),
  refs: new ReleaseRefs(DynamoDBDocumentClient.from(new DynamoDBClient({})), table),
}), { out: (line) => console.log(line), err: (line) => console.error(line) }).then((code) => { process.exitCode = code; });
