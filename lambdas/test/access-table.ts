import { type TestContext } from "node:test";

// An in-memory access table behind the shared document client. It reads the
// expression forms the access handlers write: `=`, `<`, `>`, `IN`, `begins_with`,
// `attribute_exists`, AND and OR, and SET or REMOVE updates. Queries answer
// two items a page, so a reader that ignores the cursor is caught.

export type Item = Record<string, unknown>;

type Input = Record<string, unknown> & {
  Key?: { pk: string; sk: string };
  ConditionExpression?: string;
  FilterExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
};

type Command = Readonly<{ constructor: { name: string }; input: Input }>;

export type TableOptions = Readonly<{
  /** Answers the Owner count, which reads an index that may lag the profiles. */
  ownerCount?: () => number;
  /** Runs before a transaction is checked, to change the table under it or to fail it. */
  beforeTransact?: (table: Map<string, Item>) => void;
}>;

const id = (pk: unknown, sk: unknown) => `${String(pk)}\u0000${String(sk)}`;

function splitTop(expression: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0 && expression.startsWith(separator, index)) {
      parts.push(expression.slice(start, index));
      start = index + separator.length;
    }
  }
  parts.push(expression.slice(start));
  return parts.map((part) => part.trim());
}

function unwrap(expression: string): string {
  const trimmed = expression.trim();
  if (!trimmed.startsWith("(")) return trimmed;
  let depth = 0;
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] === "(") depth += 1;
    if (trimmed[index] === ")") depth -= 1;
    if (depth === 0) return index === trimmed.length - 1 ? trimmed.slice(1, -1).trim() : trimmed;
  }
  return trimmed;
}

export function holds(item: Item | undefined, expression: string | undefined, input: Input): boolean {
  if (expression === undefined) return true;
  const names = input.ExpressionAttributeNames ?? {};
  const values = input.ExpressionAttributeValues ?? {};
  const attribute = (name: string) => item?.[names[name] ?? name];
  const term = (text: string): boolean => {
    let match = /^attribute_exists\((\S+)\)$/.exec(text);
    if (match) return attribute(match[1]!) !== undefined;
    match = /^attribute_not_exists\((\S+)\)$/.exec(text);
    if (match) return attribute(match[1]!) === undefined;
    match = /^begins_with\((\S+), (:\w+)\)$/.exec(text);
    if (match) return typeof attribute(match[1]!) === "string" && (attribute(match[1]!) as string).startsWith(String(values[match[2]!]));
    match = /^(\S+) IN \(([^)]*)\)$/.exec(text);
    if (match) return match[2]!.split(",").map((value) => values[value.trim()]).includes(attribute(match[1]!));
    match = /^(\S+) (<|>) (:\w+)$/.exec(text);
    if (match) {
      const [left, right] = [attribute(match[1]!), values[match[3]!]] as [number, number];
      return typeof left === "number" && (match[2] === "<" ? left < right : left > right);
    }
    match = /^(\S+) = (:\w+)$/.exec(text);
    if (match) return attribute(match[1]!) !== undefined && attribute(match[1]!) === values[match[2]!];
    throw new Error(`unsupported expression: ${text}`);
  };
  return splitTop(expression, " OR ").some((part) => splitTop(unwrap(part), " AND ").every((text) => term(unwrap(text))));
}

function applyUpdate(item: Item, input: Input): void {
  const expression = String(input.UpdateExpression);
  const names = input.ExpressionAttributeNames ?? {};
  const values = input.ExpressionAttributeValues ?? {};
  for (const [, action, body] of expression.matchAll(/(SET|REMOVE)\s+(.*?)(?=\s+(?:SET|REMOVE)\s+|$)/g)) {
    for (const part of body!.split(",").map((text) => text.trim())) {
      if (action === "REMOVE") delete item[names[part] ?? part];
      else {
        const [name, value] = part.split(" = ").map((text) => text.trim());
        item[names[name!] ?? name!] = values[value!];
      }
    }
  }
}

function cancelled(reasons: readonly { Code: string }[]): Error {
  return Object.assign(new Error("Transaction cancelled"), { name: "TransactionCanceledException", CancellationReasons: reasons });
}

function conditionFailed(): Error {
  return Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
}

export function accessTable(t: TestContext, document: { send: unknown }, items: readonly Item[], options: TableOptions = {}) {
  const table = new Map<string, Item>(items.map((item) => [id(item.pk, item.sk), structuredClone(item)]));
  const sent: Command[] = [];
  const page = (matches: Item[], input: Input) => {
    const offset = (input.ExclusiveStartKey as { offset?: number } | undefined)?.offset ?? 0;
    const slice = matches.slice(offset, offset + 2);
    return {
      Items: slice.map((item) => structuredClone(item)), Count: slice.length,
      ...(offset + 2 < matches.length ? { LastEvaluatedKey: { offset: offset + 2 } } : {}),
    };
  };
  t.mock.method(document as { send: (command: Command) => Promise<unknown> }, "send", async (command: Command) => {
    sent.push(command);
    await Promise.resolve();
    const input = command.input;
    const key = input.Key === undefined ? "" : id(input.Key.pk, input.Key.sk);
    switch (command.constructor.name) {
      case "GetCommand": {
        const item = table.get(key);
        return { Item: item === undefined ? undefined : structuredClone(item) };
      }
      case "QueryCommand": {
        const values = input.ExpressionAttributeValues ?? {};
        const [field, placeholder] = String(input.KeyConditionExpression).split(" = ");
        const matches = [...table.values()]
          .filter((item) => item[field!] === values[placeholder!])
          .filter((item) => holds(item, input.FilterExpression, input));
        if (input.Select === "COUNT" && options.ownerCount !== undefined) return { Count: options.ownerCount() };
        return page(matches, input);
      }
      case "ScanCommand":
        return page([...table.values()].filter((item) => holds(item, input.FilterExpression, input)), input);
      case "PutCommand": {
        const item = input.Item as Item;
        if (!holds(table.get(id(item.pk, item.sk)), input.ConditionExpression, input)) throw conditionFailed();
        table.set(id(item.pk, item.sk), structuredClone(item));
        return {};
      }
      case "DeleteCommand":
        if (!holds(table.get(key), input.ConditionExpression, input)) throw conditionFailed();
        table.delete(key);
        return {};
      case "UpdateCommand": {
        if (!holds(table.get(key), input.ConditionExpression, input)) throw conditionFailed();
        const item = table.get(key) ?? { pk: input.Key!.pk, sk: input.Key!.sk };
        applyUpdate(item, input);
        table.set(key, item);
        return {};
      }
      case "TransactWriteCommand": {
        // Checked and applied with no await between, so transactions serialise.
        options.beforeTransact?.(table);
        const writes = (input.TransactItems as Record<string, Input>[]).map((entry) => {
          const [kind, write] = Object.entries(entry)[0]!;
          const target = kind === "Put" ? write.Item as Item : write.Key!;
          return { kind, write, key: id(target.pk, target.sk) };
        });
        const reasons = writes.map(({ write, key }) => ({ Code: holds(table.get(key), write.ConditionExpression, write) ? "None" : "ConditionalCheckFailed" }));
        if (reasons.some((reason) => reason.Code !== "None")) throw cancelled(reasons);
        for (const { kind, write, key } of writes) {
          if (kind === "Delete") table.delete(key);
          if (kind === "Put") table.set(key, structuredClone(write.Item as Item));
          if (kind === "Update") {
            const item = table.get(key) ?? { pk: write.Key!.pk, sk: write.Key!.sk };
            applyUpdate(item, write);
            table.set(key, item);
          }
        }
        return {};
      }
      default:
        throw new Error(`unexpected ${command.constructor.name}`);
    }
  });
  return {
    table,
    sent,
    get: (pk: string, sk: string) => table.get(id(pk, sk)),
    transactionCancelled: cancelled,
  };
}
