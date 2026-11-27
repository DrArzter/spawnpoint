// The states a workflow uses to write its operation record (ADR-0105). They are
// the workflow's only JSONata states. A test about a workflow's own logic reads
// the workflow without them, as it was before the record; operation-workflows.test.ts
// checks the record states themselves.

type AnyState = Record<string, unknown> & {
  Type: string;
  QueryLanguage?: string;
  Next?: string;
  End?: boolean;
  Default?: string;
  Choices?: Array<Record<string, unknown>>;
  Catch?: Array<Record<string, unknown>>;
  Parameters?: Record<string, unknown>;
};

const END = Symbol("end");

export function isOperationRecordState(state: Readonly<{ QueryLanguage?: string }>): boolean {
  return state.QueryLanguage === "JSONata";
}

// The two input fields a nested run gets only for its record.
const NESTED_RECORD_INPUT = ["operationParent.$", "operationRoot.$"];

/** The definition with every record state removed and each edge joined to where that state led. */
export function withoutOperationRecord<Definition extends { StartAt?: string; States: Record<string, unknown> }>(definition: Definition): Definition {
  const states = definition.States as Record<string, AnyState>;
  const through = (target: string, seen = new Set<string>()): string | typeof END => {
    const state = states[target];
    if (state === undefined || !isOperationRecordState(state)) return target;
    if (seen.has(target)) throw new Error(`record states loop at ${target}`);
    seen.add(target);
    if (state.Type === "Succeed" || state.End === true) return END;
    const next = state.Type === "Choice" ? state.Default : state.Next;
    if (next === undefined) throw new Error(`record state ${target} leads nowhere`);
    return through(next, seen);
  };
  const edge = (target: string): string => {
    const resolved = through(target);
    if (resolved === END) throw new Error(`only a Next may lead to an end write: ${target}`);
    return resolved;
  };
  const kept: Record<string, AnyState> = {};
  for (const [name, state] of Object.entries(states)) {
    if (isOperationRecordState(state)) continue;
    const copy: AnyState = { ...state };
    if (copy.Next !== undefined) {
      const next = through(copy.Next);
      if (next === END) { delete copy.Next; copy.End = true; } else copy.Next = next;
    }
    if (copy.Default !== undefined) copy.Default = edge(copy.Default);
    if (copy.Choices) copy.Choices = copy.Choices.map((choice) => ({ ...choice, Next: edge(String(choice.Next)) }));
    if (copy.Catch) copy.Catch = copy.Catch.map((catcher) => ({ ...catcher, Next: edge(String(catcher.Next)) }));
    const input = copy.Parameters?.Input;
    if (input !== null && typeof input === "object" && !Array.isArray(input) && NESTED_RECORD_INPUT.some((key) => key in input)) {
      const rest = Object.fromEntries(Object.entries(input).filter(([key]) => !NESTED_RECORD_INPUT.includes(key)));
      copy.Parameters = { ...copy.Parameters, Input: rest };
    }
    kept[name] = copy;
  }
  if (definition.StartAt === undefined) return { ...definition, States: kept };
  const start = through(definition.StartAt);
  if (start === END) throw new Error("the start leads to an end write");
  return { ...definition, StartAt: start, States: kept };
}
