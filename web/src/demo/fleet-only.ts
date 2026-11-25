import { initialState, type DemoState } from "./data";

// `?demo&fixture=fleet`: every world has moved to the fleet and the persistent
// host is stopped, so the worlds page offers to delete it (ADR-0100).
export function fleetOnlyState(): DemoState {
  const state = initialState();
  for (const game of state.snapshot.games) {
    for (const world of game.worlds) {
      if (world.placement !== "configured") continue;
      world.placement = "fleet";
      world.connectivity = "route53";
      world.auth = "game";
    }
  }
  for (const host of state.snapshot.hosts) if (host.provenance !== "launched") host.state = "stopped";
  return state;
}
