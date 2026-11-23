import { type TestContext } from "node:test";

// An in-memory access table for the role store: the item shapes and the few
// condition expressions it writes, nothing more.

type Item = Record<string, unknown>;
type Input = Readonly<{
  Key?: { pk: string; sk: string }; Item?: Item; IndexName?: string; ConditionExpression?: string;
  ExpressionAttributeValues?: Record<string, unknown>; UpdateExpression?: string;
}>;

export class ConditionalCheckFailed extends Error {
  override name = "ConditionalCheckFailedException";
}

export function accessTable(t: TestContext, document: { send: (command: never) => Promise<unknown> }, seed: readonly Item[] = []) {
  const items = new Map<string, Item>(seed.map((item) => [`${String(item.pk)}|${String(item.sk)}`, { ...item }]));
  const keyOf = (key: { pk: string; sk: string }) => `${key.pk}|${key.sk}`;
  const holds = (expression: string | undefined, current: Item | undefined, values: Record<string, unknown>): boolean => {
    if (expression === undefined) return true;
    return expression.split(" OR ").some((alternative) => alternative.trim().replace(/^\((.*)\)$/, "$1").split(" AND ").every((clause) => {
      const part = clause.trim();
      if (part === "attribute_not_exists(pk)") return current === undefined;
      if (part === "attribute_exists(pk)") return current !== undefined;
      const match = /^(\S+) = (:\w+)$/.exec(part);
      if (match === null) throw new Error(`unsupported condition: ${part}`);
      const left = match[1]!.startsWith(":") ? values[match[1]!] : current?.[match[1]!];
      return left === values[match[2]!];
    }));
  };
  t.mock.method(document, "send", async (command: { constructor: { name: string }; input: Input }) => {
    const input = command.input;
    const values = input.ExpressionAttributeValues ?? {};
    switch (command.constructor.name) {
      case "GetCommand":
        return { Item: items.get(keyOf(input.Key!)) };
      case "QueryCommand": {
        const wanted = Object.values(values)[0];
        return { Items: [...items.values()].filter((item) => item.gsi1pk === wanted) };
      }
      case "PutCommand": {
        const key = keyOf(input.Item as { pk: string; sk: string });
        if (!holds(input.ConditionExpression, items.get(key), values)) throw new ConditionalCheckFailed("condition");
        items.set(key, { ...input.Item });
        return {};
      }
      case "DeleteCommand": {
        const key = keyOf(input.Key!);
        if (!holds(input.ConditionExpression, items.get(key), values)) throw new ConditionalCheckFailed("condition");
        items.delete(key);
        return {};
      }
      case "UpdateCommand": {
        const key = keyOf(input.Key!);
        const next: Item = { ...(items.get(key) ?? input.Key) };
        for (const assignment of (input.UpdateExpression ?? "").replace(/^SET /, "").split(", ")) {
          const [name, value] = assignment.split(" = ");
          next[name!.trim()] = values[value!.trim()];
        }
        items.set(key, next);
        return {};
      }
      default:
        throw new Error(`unsupported command: ${command.constructor.name}`);
    }
  });
  return items;
}
