# ADR-0105 — Every operation writes its own record

- Status: Accepted
- Date: 2026-11-27
- Milestone: M6
- Amends: [ADR-0015](0015-observability-and-alerting.md), [ADR-0049](0049-project-control-plane-events-into-dynamodb.md) — where the panel reads a running operation from

## Context

The panel shows a world's running operation (start, stop, promotion, world change): its state, its step and sub-step,
and the host's log lines. Today the API infers all of this from Step Functions internals:

| What the panel shows | Where the API reads it today |
| --- | --- |
| which operations run | `ListExecutions` (eventually consistent) on each operation machine |
| the world of an operation | the execution's input, `worldId` at the top |
| which run is the outer one | the execution name: a nested run is `<parent>-target-start`, `<parent>-host-start` |
| the type of an operation | the execution name, `panel-<type>-…` |
| the step and the sub-step | the newest state-entered event in the history, and of the nested run the history names |
| the host of the log | the nested host start's input: `request.instanceId`, or `instanceId` at the top |
| the command of the log | `ListCommands` on that host, in the time window of the host start |

Each workflow change broke one of these readers in a new place. #301, #331, #339 and #340 each fixed one such drift.
The cause is the same each time: the reader depends on how a workflow names its runs and shapes its inputs, and no
test holds the workflow to that.

## Decision

**Each operation workflow writes one record of its own run, and every reader reads only that record.** The workflow
knows its step, its host and its command when they happen; it says so with a direct Step Functions DynamoDB
`UpdateItem` task. Since ADR-0104 the table's stream sends the panel's reload message, so each write reaches open
panels with no code of its own.

### Where the record lives

The record is an item in `spawnpoint-control-plane-view`, beside the projection it replaces a part of. That table
already has a `pk`/`sk` key, a TTL attribute (`expires_at`), point-in-time recovery and a stream that the panel
listens to. The lifecycle table does not suit: it has a hash key only, no TTL, and listing records there is a scan.

| Access | How |
| --- | --- |
| one operation, by its id (progress route, host log) | `GetItem`, consistent, on `pk = OPERATION#<operation_id>`, `sk = RECORD` |
| the operations that run now (snapshot, the guard against a second operation) | `Query` on the sparse index `open_operations`: hash `open_key`, range `started_at` |
| the nested run an operation is in now | `GetItem` on the parent's `child_id`, at most two levels |

The key is built by one function, `operationRecordKey(operationId)` in `lambdas/src/control-plane/operation-record.ts`.
Every reader and the tests call it. The workflow templates cannot call TypeScript, so the contract test holds their
key expression to the same shape.

`open_key` is set (to `open`) by every write of a running operation and removed by the write that ends it, so the index
holds only running records: a few items. Its read is eventually consistent, as `ListExecutions` is, but its lag is
milliseconds, not seconds; the lease in the lifecycle record stays the real guard against two operations.

### The record

The operation id is the execution name, `$$.Execution.Name`. A run that the panel starts is named after the panel's
operation id, so the progress route's id does not change. A nested run has a name of its own and gets its own record.

| Attribute | Type | Set by | Meaning |
| --- | --- | --- | --- |
| `pk`, `sk` | S | every write | `OPERATION#<operation_id>`, `RECORD` |
| `operation_id` | S | accepted | the execution name |
| `execution_arn` | S | accepted | the execution, for the projector's end write |
| `type` | S | accepted | `start`, `stop`, `promote`, `world`, `host` |
| `workflow` | S | accepted | the workflow of `operation-steps.ts` (`start-host` for the host start), so a reader knows the step table |
| `world_id` | S | accepted | from the execution input; absent for a host operation |
| `game_id` | S | accepted, when the input has it | |
| `server_id` | S | accepted, when the input has it | the lifecycle record's key |
| `parent_id` | S | accepted, nested runs only | the operation id of the run that started this one |
| `root_id` | S | accepted | the outermost run; its own id when it is not nested |
| `child_id` | S | the child's accepted write | the newest nested run of this one |
| `status` | S | accepted, end | `running`, then `succeeded`, `failed`, `timed_out` or `aborted` |
| `step` | S | each step the panel shows | the step key of `operation-steps.ts` |
| `host_instance_id` | S | the host start, once known | also written to the root record, for the log |
| `command_id` | S | the host start, once sent | also written to the root record, for the log |
| `result` | S | a successful end | the workflow's own `status`: `promoted`, `ready`, … |
| `error`, `cause` | S | a failed end | the workflow's error name and cause, as the workflow states them |
| `caught_error`, `caught_cause`, `caught_step` | S | a path that catches a failure and goes on | for example before a rollback |
| `started_at` | S | accepted | `$$.Execution.StartTime`, ISO 8601 |
| `updated_at` | S | every write | `$$.State.EnteredTime` |
| `ended_at` | S | end | |
| `open_key` | S | running writes; removed at the end | the key of the `open_operations` index |
| `expires_at` | N | accepted | 30 days after `started_at` (TTL) |

An attribute the run cannot know is absent; `result` and the caught fields are an empty string when the workflow gave
none, and a reader reads an empty string as none. All attribute names are snake_case (stored); the API's JSON stays
camelCase (`contract/operations.ts`). The panel's words for a step come from the message catalogue by the step key, as
now.

### Who writes it

1. **The workflow, with a direct `dynamodb:updateItem` task.** The task uses JSONata (a JSONata state in a JSONPath
   workflow), because only JSONata can compute the TTL from the start time. It reads its facts from the context object
   (`$states.context.Execution`), not from the state data, so the same task fits anywhere in the workflow; its output
   is its input, so the workflow's data does not change. A failed write is retried and then caught: a record is a
   view, and it never fails an operation.
   The record states are named `Report …` and are the workflow's only JSONata states; that is how the tests tell
   them apart from the workflow's own states.
2. **Writes:** accepted (the first state); each step that the panel shows, on every edge that enters it from another
   step; the host and the command once they are known; and every end. Each `Fail` and `Succeed` state, and each state
   with `End`, is reached only through a write that sets the final status. A state that ended the run now leads to its
   end write, which ends it; when that write fails, a `Succeed` named `Report … Missed` ends the run instead. A `Catch`
   path that goes on writes the caught error.
3. **A nested run** gets `operationParent` (`$$.Execution.Name`) and `operationRoot` in its input from the state that
   starts it. The accepted write keeps the root in a workflow variable, `$operationRoot`, so the run can pass it on.
   The child's accepted write also sets the parent's `child_id`.
4. **The projector closes what a workflow cannot.** An aborted or timed-out run, or an error that no `Catch` handles,
   ends without its own end write. The projector already receives every Step Functions status change of the operation
   machines, and the rule now sends the host start and host stop too. On an end status it updates the record with
   the condition `status = running`, so it never overwrites the workflow's own end.
5. **Grants:** each workflow role and the projector get `dynamodb:UpdateItem` on the view table, limited by
   `dynamodb:LeadingKeys` to `OPERATION#*`. Nothing else may write a record.

### Who reads it

- **The snapshot:** the running operations are the `open_operations` records without a `parent_id`. This replaces
  `ListExecutions`, the execution names and `outerOperations`.
- **The progress route:** the record by its id; while it runs, its `step`, and the step of the running run that
  `child_id` names (at most two levels down); its `result`, `error`, `cause` and caught error.
- **The host log:** `host_instance_id` and `command_id` of the record. No history and no `ListCommands`.
- **The stream:** the panel's stream filter on the view table passes keys that begin with `OPERATION#`, so a step
  change pushes a reload.

### The guard

`lambdas/test/operation-workflows.test.ts` parses every operation workflow: start, stop, promotion, world lifecycle,
the drain, the host deletion, and the nested host start and host stop. It fails when:

1. a state is neither mapped to a step in `operation-steps.ts` nor listed there as not shown;
2. a state that starts the host workflow does not pass the instance where the host-log reader takes it from.

The second writes `host_instance_id` once the record exists. From the second change on, the guard also fails when a
path from the start to an end does not pass through a write that sets the final status, or when an edge into a shown
step does not pass through a write of that step.

### Rollout

| Change | What it does | The old reader |
| --- | --- | --- |
| 1 | this ADR and the guard on today's workflows | in use |
| 2 | the record, its key builder, the index, the writes, the grants, the projector's end write | in use |
| 3 | the readers read the record; an operation without a record (started before change 2 was deployed) reads the old way and logs `operation_record_fallback` | fallback only |
| 4 | after one deploy with no `operation_record_fallback` line in CloudWatch, the fallback is removed | removed |

**Removed at the end:** the execution-name parsing (`operationTypeOfId`, the `-target-start` and `-host-start`
suffixes), `outerOperations`, the history scan for the step and the nested run (`NESTED_STATES`, `deepestChild`,
`findHostRun`), `ListCommands` for the host log, and `ListExecutions` for the running list with its `DescribeExecution`
cache. The ETA still reads the finished runs of each machine, until the records hold enough history to replace it.
The state-to-step tables in `operation-steps.ts` stay: they become the guard's map of where each write must be.

## Alternatives

- **Keep the inference and fix each drift.** Four fixes in two weeks; each one found in production.
- **A Lambda that writes the record.** One more function on every step, with its own failure mode, for a write that
  Step Functions can make itself.
- **The record in the lifecycle table.** No TTL, no sort key, and listing is a scan.
- **Only the projector writes, from status-change events.** Step Functions sends no event per state, so the step and
  the host stay unknown.

## Costs

- **State transitions:** a write is one more transition, $0.000025 each. A start has about 15 writes; at the volume of
  ADR-0104 this is cents a month. Not measured.
- **Writes:** one write unit per write (a record is under 1 KB), and one more on the index while the record is open.
- **Reads:** fewer. The snapshot makes one index query instead of a `ListExecutions` per machine and a
  `DescribeExecution` per new run; the progress route makes up to three `GetItem` calls instead of up to three history
  pages per run and a `ListCommands`.

## Consequences

- A workflow change that adds a state the panel shows fails the guard until the state has a step and a write.
- The record says what the workflow says; a run that the workflow does not describe is not shown.
- Records expire 30 days after they start. Point-in-time recovery covers them with the rest of the table.
- An operation that started before change 2 never gets a record. Change 3 reads it the old way until it ends; change 4
  waits for one deploy with none.
