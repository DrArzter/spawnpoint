import type { TableChange } from "./panel-changes.ts";

/*
 * Reads the batch a DynamoDB stream hands to Lambda (ADR-0104): the table from
 * the stream ARN, the item images from DynamoDB's typed attribute values. It
 * reads only the shapes our tables hold; a set or a binary value reads as
 * absent, since no field the panel shows is one.
 */

type AttributeValue = Readonly<Record<string, unknown>>;

const KINDS: Readonly<Record<string, TableChange["kind"]>> = { INSERT: "insert", MODIFY: "modify", REMOVE: "remove" };

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function attribute(value: unknown): unknown {
  if (!isObject(value)) return undefined;
  const attributeValue = value as AttributeValue;
  if (typeof attributeValue.S === "string") return attributeValue.S;
  if (typeof attributeValue.N === "string") return Number(attributeValue.N);
  if (typeof attributeValue.BOOL === "boolean") return attributeValue.BOOL;
  if (attributeValue.NULL === true) return null;
  if (isObject(attributeValue.M)) return image(attributeValue.M);
  if (Array.isArray(attributeValue.L)) return attributeValue.L.map(attribute);
  return undefined;
}

function image(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!isObject(value)) return null;
  const item: Record<string, unknown> = {};
  for (const [name, typed] of Object.entries(value)) {
    const read = attribute(typed);
    if (read !== undefined) item[name] = read;
  }
  return item;
}

/** `arn:aws:dynamodb:<region>:<account>:table/<name>/stream/<label>` → `<name>`. */
export function streamTableName(arn: unknown): string | null {
  if (typeof arn !== "string") return null;
  return /^arn:aws[a-z-]*:dynamodb:[^:]*:[^:]*:table\/([^/]+)\/stream\//.exec(arn)?.[1] ?? null;
}

/** A batch from a DynamoDB stream event source mapping, as opposed to a WebSocket route. */
export function isStreamBatch(event: unknown): event is Readonly<{ Records: readonly unknown[] }> {
  return isObject(event) && Array.isArray(event.Records);
}

export function streamChanges(event: Readonly<{ Records: readonly unknown[] }>): readonly TableChange[] {
  return event.Records.flatMap((record): TableChange[] => {
    if (!isObject(record) || !isObject(record.dynamodb)) return [];
    const kind = KINDS[String(record.eventName)];
    const table = streamTableName(record.eventSourceARN);
    const keys = image(record.dynamodb.Keys);
    if (kind === undefined || table === null || keys === null) return [];
    const seconds = record.dynamodb.ApproximateCreationDateTime;
    return [{
      table,
      kind,
      keys,
      oldImage: image(record.dynamodb.OldImage),
      newImage: image(record.dynamodb.NewImage),
      atEpochMilliseconds: typeof seconds === "number" && Number.isFinite(seconds) ? Math.round(seconds * 1000) : null,
    }];
  });
}
