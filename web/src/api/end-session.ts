import type { SpawnpointApi } from "./contract";

// The front door has its own address so a sign-out lands there even if the
// session outlives the request that was meant to end it.
const FRONT_DOOR = "#/welcome";

function returnToFrontDoor(): void {
  // Assigning a hash-only difference never reloads the document, which used to
  // leave a signed-out tab holding the session's data and its React state.
  // Rewriting the address and reloading is the one path that always ends clean.
  window.history.replaceState(null, "", `${window.location.pathname}${FRONT_DOOR}`);
  window.location.reload();
}

export async function endSession(api: SpawnpointApi): Promise<void> {
  try {
    await api.revokeSession();
  } finally {
    returnToFrontDoor();
  }
}
