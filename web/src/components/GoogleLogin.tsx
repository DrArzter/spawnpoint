import { useEffect, useRef, useState } from "react";

import { AuthState, exchangeGoogleOidc, googleOidcClientId } from "../auth";
import { Button } from "./ui/Button";
import { Skeleton } from "./ui/Skeleton";

// The slice of Google Identity Services this panel uses. Google draws the
// button itself: for the ID-token flow its brand rules allow no other, so the
// panel gives it a place, a width and a theme, and takes the token back.
type GoogleCredential = Readonly<{ credential?: string }>;
type GoogleButtonTheme = "outline" | "filled_black";
type GoogleIdentity = Readonly<{
  initialize(options: { client_id: string; callback: (response: GoogleCredential) => void; auto_select?: boolean }): void;
  renderButton(parent: HTMLElement, options: {
    type: "standard";
    theme: GoogleButtonTheme;
    size: "large";
    text: "continue_with";
    shape: "rectangular";
    logo_alignment: "left";
    width?: number;
  }): void;
}>;

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdentity } };
  }
}

import { GOOGLE_CLIENT_ID } from "../lib/signin";

export { GOOGLE_CLIENT_ID };

// The console speaks English everywhere. Google's default follows the account's
// language, and the `locale` option of renderButton does not override it; the
// script's own `hl` parameter does, so one Polish button never sits under an
// English form.
const SCRIPT_URL = "https://accounts.google.com/gsi/client?hl=en";
// Google accepts a button between these two widths and nothing outside them.
const MINIMUM_WIDTH = 200;
const MAXIMUM_WIDTH = 400;
let loading: Promise<GoogleIdentity> | null = null;

// One script per document, however many buttons ask for it. A failed load is
// forgotten, so "Try again" really tries again.
function loadGoogleIdentity(): Promise<GoogleIdentity> {
  const present = window.google?.accounts?.id;
  if (present !== undefined) return Promise.resolve(present);
  loading ??= new Promise<GoogleIdentity>((resolve, reject) => {
    const script = document.createElement("script");
    script.async = true;
    script.src = SCRIPT_URL;
    script.onload = () => {
      const identity = window.google?.accounts?.id;
      if (identity === undefined) reject(new Error("Google sign-in loaded without its identity library."));
      else resolve(identity);
    };
    script.onerror = () => reject(new Error("Google sign-in could not load."));
    document.head.append(script);
  }).catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

function currentTheme(): GoogleButtonTheme {
  return document.documentElement.dataset.theme === "dark" ? "filled_black" : "outline";
}

export function GoogleLoginButton({ onChange, onToken, className }: Readonly<{
  onChange?: (state: AuthState) => void;
  onToken?: (idToken: string) => Promise<void>;
  className?: string;
}>) {
  const mounted = useRef(true);
  const box = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const identity = useRef<GoogleIdentity | null>(null);
  const onChangeRef = useRef(onChange);
  const onTokenRef = useRef(onToken);
  onChangeRef.current = onChange;
  onTokenRef.current = onToken;
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [theme, setTheme] = useState<GoogleButtonTheme>(currentTheme);
  const [width, setWidth] = useState(MINIMUM_WIDTH);

  useEffect(() => {
    mounted.current = true;
    if (!GOOGLE_CLIENT_ID.test(googleOidcClientId)) {
      setLoginError("Google sign-in is missing its client ID.");
      return;
    }
    const complete = (response: GoogleCredential) => {
      if (typeof response.credential !== "string") {
        if (mounted.current) setLoginError("Google did not return an identity token.");
        return;
      }
      if (onTokenRef.current !== undefined) {
        setBusy(true);
        void onTokenRef.current(response.credential)
          .catch((cause: unknown) => { if (mounted.current) setLoginError(cause instanceof Error ? cause.message : "Google could not link this account."); })
          .finally(() => { if (mounted.current) setBusy(false); });
      } else if (onChangeRef.current !== undefined) {
        onChangeRef.current({ status: "loading" });
        void exchangeGoogleOidc(response.credential).then((state) => onChangeRef.current?.(state));
      }
    };
    loadGoogleIdentity()
      .then((library) => {
        if (!mounted.current) return;
        library.initialize({ client_id: googleOidcClientId, callback: complete, auto_select: false });
        identity.current = library;
        setReady(true);
      })
      .catch((cause: unknown) => {
        if (mounted.current) setLoginError(cause instanceof Error ? cause.message : "Google sign-in could not load.");
      });
    return () => { mounted.current = false; };
  }, [attempt]);

  // Google paints the button in the colours it is told and at the width it is
  // given; the theme toggle and the box's width are both ours, so both are watched.
  useEffect(() => {
    const root = document.documentElement;
    const themeObserver = new MutationObserver(() => setTheme(currentTheme()));
    themeObserver.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    const element = box.current;
    const measure = () => {
      if (element === null) return;
      const measured = Math.round(element.getBoundingClientRect().width);
      setWidth(Math.min(MAXIMUM_WIDTH, Math.max(MINIMUM_WIDTH, measured)));
    };
    measure();
    const sizeObserver = new ResizeObserver(measure);
    if (element !== null) sizeObserver.observe(element);
    return () => {
      themeObserver.disconnect();
      sizeObserver.disconnect();
    };
  }, [attempt]);

  useEffect(() => {
    const library = identity.current;
    const element = slot.current;
    if (!ready || library === null || element === null) return;
    element.replaceChildren();
    library.renderButton(element, { type: "standard", theme, size: "large", text: "continue_with", shape: "rectangular", logo_alignment: "left", width });
  }, [ready, theme, width]);

  return (
    <div className={className ?? "google-login"} ref={box}>
      {!loginError && !ready && <Skeleton height={40} />}
      {!loginError && <div aria-busy={busy || undefined} className="google-login-slot" hidden={!ready} ref={slot} />}
      {loginError && <div className="boot-copy" role="alert">
        <p className="boot-error">{loginError}</p>
        <Button onClick={() => { setLoginError(""); setReady(false); setAttempt((value) => value + 1); }}>Try again</Button>
      </div>}
    </div>
  );
}
