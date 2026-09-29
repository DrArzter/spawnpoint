import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";

import { AuthState, restoreAuth } from "./auth";
import { SnackbarProvider } from "./components/ui/Snackbar";
import { ConsoleRoot } from "./core/Console";
import { isLandingHash, isRootHash, readAccessInvitationRoute, readEmailActionRoute } from "./routing";
import { AuthScreen } from "./screens/AuthScreen";
import { EmailActionScreen } from "./screens/EmailActionScreen";
import { JoinScreen } from "./screens/JoinScreen";
import { LandingScreen } from "./screens/LandingScreen";
import { useBootCard } from "./shell/hooks";
import { chooseSkin, currentSkinId, isSkinId, SKIN_CHOICES, wearOnDocument, wearSkin } from "./skins";

// The gate in front of the console: who is here, and which door they came
// through. The console itself is bones under a skin (core/Console.tsx).
export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [atLanding, setAtLanding] = useState(() => isLandingHash());
  const [joinToken, setJoinToken] = useState(() => readAccessInvitationRoute());
  const { visible: bootVisible, publish } = useBootCard();
  const emailAction = readEmailActionRoute();
  const skin = useMemo(chooseSkin, []);
  const looks = useMemo(() => ({ current: currentSkinId(), options: SKIN_CHOICES, wear: (id: string) => { if (isSkinId(id)) wearSkin(id); } }), []);

  useEffect(() => {
    let active = true;
    restoreAuth()
      .then((state) => publish(() => {
        if (!active) return;
        setAuth(state);
        // Arriving at the bare root with a session already in hand means the
        // console, not the front door: the Mini App opens that way every time,
        // and so does a browser that still holds its refresh cookie. The front
        // door keeps its own address at `#/welcome`.
        if (state.status === "authenticated" && state.session.state === "active" && isRootHash()) {
          window.history.replaceState(null, "", "#/worlds");
          setAtLanding(false);
        }
      }))
      .catch((error: unknown) => publish(() => {
        if (!active) return;
        setAuth({ status: "error", message: error instanceof Error ? error.message : "Sign-in failed." });
      }));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const onChange = () => { setAtLanding(isLandingHash()); setJoinToken(readAccessInvitationRoute()); };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  // The boot and the console wear the chosen face; the front door, the join
  // and email screens never do. Decided here, once, for every surface.
  const consoleSurface = emailAction === null && joinToken === null
    && (auth.status === "loading" || (!atLanding && auth.status === "authenticated" && auth.session.state === "active"));
  useLayoutEffect(() => { wearOnDocument(skin.id, consoleSurface); }, [skin, consoleSurface]);

  // A sign-in started on the front door ends in the console; an account that
  // holds no role yet lands on the card that asks for one.
  const handleAuth = useCallback((state: AuthState) => {
    setAuth(state);
    if (state.status === "authenticated" && isLandingHash()) window.location.hash = "#/worlds";
  }, []);

  // The session is settled before anything else is drawn. Deciding later is what
  // made the front door appear first and then rearrange itself: a sign-in button
  // arriving from nowhere, or a jump into the console a beat after landing.
  if (emailAction !== null) return <EmailActionScreen action={emailAction} onAuth={handleAuth} />;
  if (joinToken !== null) return <JoinScreen auth={auth} onAuth={handleAuth} proof={joinToken.proof} token={joinToken.token} />;
  if (auth.status === "loading") {
    return bootVisible ? <skin.Boot model={{ title: "Checking your session", description: "Confirming who you are with the access API." }} /> : null;
  }
  if (atLanding) return <LandingScreen auth={auth} onChange={handleAuth} />;
  if (auth.status !== "authenticated") return <LandingScreen auth={auth} onChange={handleAuth} />;
  if (auth.session.state !== "active") return <AuthScreen auth={auth} onChange={handleAuth} />;
  return <SnackbarProvider><ConsoleRoot continuesBootCard={bootVisible} looks={looks} session={auth.session} skin={skin} /></SnackbarProvider>;
}
