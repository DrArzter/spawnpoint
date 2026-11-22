import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

// An in-memory stand-in for the reference table. It understands only the
// expressions release-refs.ts writes: attribute_(not_)exists, `#s = :v`,
// `#s IN (...)`, `attr <= :v`, clauses joined by AND or OR, and SET / ADD / REMOVE updates.

type Item = Record<string, unknown>;
type Names = Record<string, string> | undefined;
type Values = Record<string, unknown> | undefined;

type Comparison = (actual: unknown, expected: unknown) => boolean;

const COMPARISONS: readonly (readonly [RegExp, Comparison])[] = [
  [/^#?\w+ = :\w+$/, (actual, expected) => actual === expected],
  [/^#?\w+ <= :\w+$/, (actual, expected) => actual !== undefined && (actual as string | number) <= (expected as string | number)],
  [/^#?\w+ > :\w+$/, (actual, expected) => Number(actual) > Number(expected)],
];

function clauseHolds(item: Item | undefined, text: string, names: Names, values: Values): boolean {
  const attribute = (token: string) => item?.[names?.[token] ?? token];
  if (/^attribute_not_exists\((\w+)\)$/.test(text)) return item === undefined;
  if (/^attribute_exists\((\w+)\)$/.test(text)) return item !== undefined;
  const [left, , right] = text.split(" ");
  for (const [pattern, compare] of COMPARISONS) {
    if (pattern.test(text)) return item !== undefined && compare(attribute(left!), values![right!]);
  }
  const list = /^(#\w+) IN \(([^)]*)\)$/.exec(text);
  if (list) return item !== undefined && list[2]!.split(",").map((name) => values![name.trim()]).includes(attribute(list[1]!));
  throw new Error(`fake table: unsupported condition ${text}`);
}

function conditionHolds(item: Item | undefined, expression: string | undefined, names: Names, values: Values): boolean {
  if (expression === undefined) return true;
  return expression.split(" OR ").some((alternative) => alternative.split(" AND ").every((clause) => clauseHolds(item, clause.trim(), names, values)));
}

function apply(item: Item, expression: string, names: Names, values: Values): Item {
  const next = { ...item };
  const name = (token: string) => names?.[token] ?? token;
  const sections = /^(?:SET (.*?))?(?: ?ADD (.*?))?(?: ?REMOVE (.*))?$/.exec(expression.trim());
  if (!sections) throw new Error(`fake table: unsupported update ${expression}`);
  const [, set, add, remove] = sections;
  for (const part of set?.split(",") ?? []) {
    const [target, value] = part.split("=").map((piece) => piece.trim());
    next[name(target!)] = values![value!];
  }
  for (const part of add?.split(",") ?? []) {
    const [target, value] = part.trim().split(" ");
    const key = name(target!);
    const amount = values![value!];
    if (amount instanceof Set) next[key] = new Set([...(next[key] instanceof Set ? next[key] as Set<string> : []), ...amount]);
    else next[key] = Number(next[key] ?? 0) + Number(amount);
  }
  for (const target of remove?.split(",") ?? []) delete next[name(target.trim())];
  return next;
}

function cancelled(reasons: readonly { Code: string }[]): Error {
  return Object.assign(new Error("transaction cancelled"), { name: "TransactionCanceledException", CancellationReasons: reasons });
}

export class FakeRefsTable {
  readonly items = new Map<string, Item>();
  /** Commands seen, for a test that wants to crash in the middle. */
  readonly commands: string[] = [];
  beforeSend: ((command: unknown) => void) | undefined;

  private id(key: Item): string {
    return `${String(key.pk)}|${String(key.sk)}`;
  }

  get(pk: string, sk: string): Item | undefined {
    return this.items.get(`${pk}|${sk}`);
  }

  put(item: Item): void {
    this.items.set(this.id(item), item);
  }

  private transactItem(entry: Record<string, Record<string, unknown>>): { ok: boolean; commit: () => void } {
    const [kind, body] = Object.entries(entry)[0]!;
    const key = (kind === "Put" ? body.Item : body.Key) as Item;
    const current = this.items.get(this.id(key));
    const ok = conditionHolds(current, body.ConditionExpression as string | undefined, body.ExpressionAttributeNames as Names, body.ExpressionAttributeValues as Values);
    return {
      ok,
      commit: () => {
        if (kind === "Put") this.items.set(this.id(key), body.Item as Item);
        else if (kind === "Delete") this.items.delete(this.id(key));
        else this.items.set(this.id(key), apply(current ?? { ...key }, body.UpdateExpression as string, body.ExpressionAttributeNames as Names, body.ExpressionAttributeValues as Values));
      },
    };
  }

  // A rejection, as the SDK client gives it, not a synchronous throw.
  send(command: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      try {
        resolve(this.handle(command));
      } catch (error) {
        reject(error);
      }
    });
  }

  private handle(command: unknown): Record<string, unknown> {
    this.beforeSend?.(command);
    this.commands.push((command as object).constructor.name);
    if (command instanceof GetCommand) {
      const found = this.items.get(this.id(command.input.Key!));
      return found === undefined ? {} : { Item: structuredClone(found) };
    }
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues!;
      const items = [...this.items.values()]
        .filter((item) => item.pk === values[":pk"] && String(item.sk).startsWith(String(values[":hold"] ?? values[":prefix"])))
        .map((item) => structuredClone(item));
      return { Items: items };
    }
    if (command instanceof PutCommand) {
      const input = command.input;
      const current = this.items.get(this.id(input.Item!));
      if (!conditionHolds(current, input.ConditionExpression, input.ExpressionAttributeNames, input.ExpressionAttributeValues)) {
        throw Object.assign(new Error("condition failed"), { name: "ConditionalCheckFailedException" });
      }
      this.items.set(this.id(input.Item!), input.Item!);
      return {};
    }
    if (command instanceof DeleteCommand) {
      this.items.delete(this.id(command.input.Key!));
      return {};
    }
    if (command instanceof UpdateCommand) {
      const input = command.input;
      const current = this.items.get(this.id(input.Key!));
      if (!conditionHolds(current, input.ConditionExpression, input.ExpressionAttributeNames, input.ExpressionAttributeValues)) {
        throw Object.assign(new Error("condition failed"), { name: "ConditionalCheckFailedException" });
      }
      this.items.set(this.id(input.Key!), apply(current ?? { ...input.Key }, input.UpdateExpression!, input.ExpressionAttributeNames, input.ExpressionAttributeValues));
      return {};
    }
    if (command instanceof TransactWriteCommand) {
      const evaluated = command.input.TransactItems!.map((entry) => this.transactItem(entry as never));
      if (evaluated.some((entry) => !entry.ok)) throw cancelled(evaluated.map((entry) => ({ Code: entry.ok ? "None" : "ConditionalCheckFailed" })));
      for (const entry of evaluated) entry.commit();
      return {};
    }
    throw new Error("fake table: unsupported command");
  }
}
