// What a running workflow is doing, in words. Each workflow state maps to one
// stable step key; operation-steps.test.ts holds every state of every workflow
// file to an entry here, so a new state cannot ship without a step.

export type OperationStep = Readonly<{ key: string; label: string }>;

/** The workflows an operation can pass through, by state machine name. */
export type WorkflowName = "promote" | "start" | "stop" | "start-host" | "stop-host" | "world";

export const WORKFLOW_MACHINES: Readonly<Record<string, WorkflowName>> = {
  "spawnpoint-promote-release": "promote",
  "spawnpoint-start-server-v2": "start",
  "spawnpoint-stop-server-v2": "stop",
  "spawnpoint-start-server": "start-host",
  "spawnpoint-stop-server": "stop-host",
  "spawnpoint-world-lifecycle": "world",
};

/** The workflow's own file under workflows/, for the test that reads it. */
export const WORKFLOW_FILES: Readonly<Record<WorkflowName, string>> = {
  promote: "promote-release.asl.json",
  start: "start-server-v2.asl.json.tftpl",
  stop: "stop-server-v2.asl.json.tftpl",
  "start-host": "start-server.asl.json",
  "stop-host": "stop-server.asl.json",
  world: "world-lifecycle.asl.json.tftpl",
};

export const ENDED = "ended";

export const STEP_LABELS: Readonly<Record<string, string>> = {
  "promote.checking_release": "Checking the release",
  "promote.checking_server": "Checking the server",
  "promote.stopping_server": "Stopping the server",
  "promote.keeping_backup": "Keeping the backup",
  "promote.starting_release": "Starting on the new release",
  "promote.recording_release": "Recording the release",
  "promote.stopping_again": "Stopping the server again",
  "promote.rolling_back": "Rolling back",
  "promote.stopping_after_rollback": "Stopping after the rollback",
  "promote.restoring_choice": "Restoring the earlier release",

  "start.preparing": "Preparing the session",
  "start.choosing_host": "Choosing a host",
  "start.launching_host": "Launching the host",
  "start.starting_server": "Starting the server",
  "start.recording": "Recording the session",
  "start.starting_watchdog": "Starting the idle watchdog",
  "start.cancelling": "Cancelling the start",
  "start.undoing": "Undoing the failed start",
  "start.forcing_stop": "Forcing the host to stop",
  "start.checking_host": "Checking the host",
  "start.waiting_host": "Waiting for the host",
  "start.running_command": "Starting the server on the host",

  "stop.checking": "Checking the session",
  "stop.locking": "Locking the session",
  "stop.finding_host": "Finding the host",
  "stop.saving": "Saving and stopping the server",
  "stop.recording": "Recording the stop",
  "stop.releasing_host": "Releasing the host",
  "stop.cancelling": "Cancelling the stop",
  "stop.checking_host": "Checking the host",
  "stop.waiting_host": "Waiting for the host",
  "stop.saving_world": "Saving the world and the backup",
  "stop.stopping_host": "Stopping the host",

  "world.checking": "Checking the server",
  "world.stopping_backing_up": "Stopping and backing up",
  "world.applying": "Applying the change",

  [ENDED]: "Ended",
};

type Table = Readonly<Record<string, readonly string[]>>;

// Step key (without the workflow's own prefix) to the states it covers.
const PROMOTE: Table = {
  "promote.checking_release": ["Initialize", "Apply Request Defaults", "Verify Release Published", "Prepare Release", "Already Active"],
  "promote.checking_server": ["Read Lifecycle", "Route Origin State", "Mark Origin Running", "Mark Origin Stopped"],
  "promote.stopping_server": ["Stop Origin Session"],
  "promote.keeping_backup": ["Keep Pre-Promotion Backup"],
  "promote.starting_release": ["Start With Target"],
  "promote.recording_release": ["Commit Active", "Route Completion"],
  "promote.stopping_again": ["Stop Target After Commit"],
  "promote.rolling_back": ["Rollback Possible", "Write Rollback Desired", "Start With Previous", "Route Rollback Completion"],
  "promote.stopping_after_rollback": ["Stop Rollback Session"],
  "promote.restoring_choice": ["Restore Desired After Missing Backup", "Restore Desired After Refusal", "Restore Desired After Unavailable Lifecycle"],
  [ENDED]: [
    "Nothing To Do", "Promoted Running", "Promoted Stopped", "Rolled Back",
    "World Not Imported", "Release Not Published", "Lifecycle Unavailable", "Pre-Promotion Backup Missing", "Promotion Refused",
    "Promotion Failed No Rollback", "Rollback Failed", "Promoted But Running", "Rolled Back But Running",
  ],
};

const START: Table = {
  "start.preparing": ["Initialize", "Apply Request Defaults", "Initialize Lifecycle", "Acquire Start Lease", "Begin Session"],
  "start.choosing_host": [
    "Route Placement Mode", "Adopt Configured Host", "Place Fleet Session", "Describe Configured Host", "Describe Configured Host Shape",
    "Register Configured Host", "Place Session", "Route Placement", "Adopt Placement",
  ],
  "start.launching_host": ["Launch Host", "Describe Launched Host Shape", "Register Launched Host", "Reserve On Launched Host"],
  "start.starting_server": ["Start Accepted V1"],
  "start.recording": [
    "Route Bookkeeping", "Describe Host", "Describe Host Shape", "Register Host", "Reserve Slot Zero", "Mark Session Ready",
    "Record Session Host", "Route Release Commit", "Commit Active Release", "Release Start Lease",
  ],
  "start.starting_watchdog": ["Start Session Watchdog"],
  "start.cancelling": [
    "Terminate Unreserved Host", "No Host Has Room", "Placement Unavailable", "Begin Cancelling Unplaced Session",
    "Mark Unplaced Session Stopped", "Release Unplaced Lease",
  ],
  "start.undoing": [
    "Acquire Watchdog Compensation Lease", "Begin Compensating Stop", "Stop Accepted V1", "Mark Compensated Session Stopped",
    "Close Compensated Session History", "Release Compensated Placement", "Release Compensating Lease", "Route Compensated Fleet Drain",
    "Start Compensated Host Drain",
  ],
  "start.forcing_stop": [
    "Force Stop Failed Start Host", "Wait Before Forced Stop Poll", "Describe Forced Stop Host", "Forced Stop Host Stopped",
    "Increment Forced Stop Poll", "Forced Stop Poll Limit Reached", "Mark Forced Session Stopped", "Close Forced Session History",
    "Release Forced Placement", "Release Forced Compensation Lease", "Route Forced Fleet Drain", "Start Forced Host Drain",
  ],
  [ENDED]: [
    "Ready", "Start Refused Unplaced", "Start Failed Host Forced Stopped", "Start Failed And Compensated", "Start Compensation Failed",
    "Start Compensation Host Not Drained",
  ],
};

const STOP: Table = {
  "stop.checking": ["Initialize", "Read Lifecycle", "Route Lifecycle"],
  "stop.locking": ["Acquire Stop Lease", "Begin Stopping Session"],
  "stop.finding_host": ["Find Placement", "Route Found Placement", "Route Unplaced Session", "Adopt Found Placement", "Adopt Requested Host"],
  "stop.saving": ["Stop Accepted V1"],
  "stop.recording": ["Mark Session Stopped", "Close Session History", "Release Placement", "Release Stop Lease"],
  "stop.releasing_host": ["Route Emptied Host", "Route Emptied Host State", "Start Drain"],
  "stop.cancelling": ["Route Stop Failure", "Cancel Refused Stop", "Release Refused Stop Lease"],
  [ENDED]: [
    "Stopped", "Already Stopped", "Stop Refused Players Online", "Stale Session", "Placement Lookup Failed", "Fleet Session Unplaced",
    "Verified Stop Failed",
  ],
};

// The host workflows: the steps the nested start and stop show on the host.
const START_HOST: Table = {
  "start.checking_host": ["Initialize", "Describe Initial Instance", "Route Initial Instance State"],
  "start.launching_host": ["Start Instance"],
  "start.waiting_host": [
    "Wait Before Instance Poll", "Describe Instance", "Instance Running", "Increment Instance Poll", "Instance Poll Limit Reached",
    "Wait Before SSM Poll", "Describe SSM Agent", "SSM Record Present", "SSM Agent Online", "Increment SSM Poll", "SSM Poll Limit Reached",
  ],
  "start.running_command": [
    "Route Session Command", "Start Fleet Session Command", "Start Placed Session Command", "Start Session Command",
    "Wait Before Command Poll", "Get Session Command", "Session Command Complete", "Increment Command Poll", "Command Poll Limit Reached",
    "Read Session Summary",
  ],
  [ENDED]: [
    "Ready", "Instance Cannot Start", "Instance Start Timed Out", "SSM Timed Out", "Session Start Failed", "Session Start Timed Out",
  ],
};

const STOP_HOST: Table = {
  "stop.checking_host": ["Initialize", "Describe Initial Instance", "Route Initial Instance State"],
  "stop.waiting_host": [
    "Wait Before SSM Poll", "Describe SSM Agent", "SSM Record Present", "SSM Agent Online", "Increment SSM Poll", "SSM Poll Limit Reached",
  ],
  "stop.saving_world": [
    "Route Stop Command", "Stop Placed Session Command", "Stop Session Command", "Wait Before Command Poll", "Get Stop Command",
    "Stop Command Complete", "Increment Command Poll", "Command Poll Limit Reached",
  ],
  "stop.stopping_host": [
    "Stop Instance", "Wait Before Instance Poll", "Describe Instance", "Instance Stopped", "Increment Instance Poll", "Instance Poll Limit Reached",
  ],
  [ENDED]: [
    "Host Still Busy", "Host Activity Unknown", "Already Stopped", "Stopped", "Instance Cannot Stop", "SSM Timed Out", "Session Stop Failed",
    "World Not On Host", "Players Online", "Session Stop Timed Out", "Instance Stop Timed Out",
  ],
};

const WORLD: Table = {
  "world.checking": ["Needs Verified Stop"],
  "world.stopping_backing_up": ["Stop And Back Up"],
  "world.applying": ["Apply World Mutation"],
  [ENDED]: ["Complete"],
};

function stateIndex(table: Table): ReadonlyMap<string, string> {
  return new Map(Object.entries(table).flatMap(([key, states]) => states.map((state) => [state, key] as const)));
}

const BY_STATE: Readonly<Record<WorkflowName, ReadonlyMap<string, string>>> = {
  promote: stateIndex(PROMOTE),
  start: stateIndex(START),
  stop: stateIndex(STOP),
  "start-host": stateIndex(START_HOST),
  "stop-host": stateIndex(STOP_HOST),
  world: stateIndex(WORLD),
};

/** Every state a workflow's table names; the test compares it with the workflow file. */
export function mappedStates(workflow: WorkflowName): readonly string[] {
  return [...BY_STATE[workflow].keys()];
}

/** A state of a known workflow as its step; null for a state no table names. */
export function stepOfState(workflow: WorkflowName, state: string): OperationStep | null {
  const key = BY_STATE[workflow].get(state);
  return key === undefined ? null : { key, label: STEP_LABELS[key]! };
}

/** The state machine's own name, the last part of its ARN. */
export function workflowOfMachine(machineArn: string): WorkflowName | null {
  const name = machineArn.split(":").at(-1) ?? "";
  return WORKFLOW_MACHINES[name] ?? null;
}

/**
 * The workflows whose state is a nested execution, by the state that runs it:
 * where the child's own step replaces the parent's.
 */
export const NESTED_STATES: Readonly<Record<WorkflowName, ReadonlySet<string>>> = {
  promote: new Set(["Stop Origin Session", "Start With Target", "Start With Previous", "Stop Target After Commit", "Stop Rollback Session"]),
  start: new Set(["Start Accepted V1", "Stop Accepted V1"]),
  stop: new Set(["Stop Accepted V1"]),
  "start-host": new Set(),
  "stop-host": new Set(),
  world: new Set(["Stop And Back Up"]),
};
