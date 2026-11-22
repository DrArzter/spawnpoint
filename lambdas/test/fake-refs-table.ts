import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

// An in-memory stand-in for the reference table. It understands only the
// expressions release-refs.ts writes: attribute_(not_)exists, `#s = :v`,
// `#s IN (...)`, `attr <= :v`, clauses joined by AND or OR, and SET / ADD / REMOVE updates.

type Item = Record<string, unknown>;
type Names = Record<string, string> | undefined;
type Values = Record<string, unknown> | undefined;

function clauseHolds(item: Item | undefined, text: string, names: Names, values: Values): boolean {
  const attribute = (token: string) => item?.[names?.[token] ?? token];
  let match = /^attribute_not_exists\((\w+)\)$/.exec(text);
  if (match) return item === undefined;
  match = /^attribute_exists\((\w+)\)$/.exec(text);
  if (match) return item !== undefined;
  match = /^(#?\w+) = (:\w+)$/.exec(text);
  if (match) return item !== undefined && attribute(match[1]!) === values![match[2]!];
  match = /^(#?\w+) <= (:\w+)$/.exec(text);
  if (match) return item !== undefined && attribute(match[1]!) !== undefined && (attribute(match[1]!) as string | number) <= (values![match[2]!] as string | number);
  match = /^(#?\w+) > (:\w+)$/.exec(text);
  if (match) return item !== undefined && Number(attribute(match[1]!)) > Number(values![match[2]!]);
  match = /^(#\w+) IN \(([^)]*)\)$/.exec(text);
  if (match) return item !== undefined && match[2]!.split(",").map((name) => values![name.trim()]).includes(attribute(match[1]!));
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

  async send(command: unknown): Promise<Record<string, unknown>> {
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
