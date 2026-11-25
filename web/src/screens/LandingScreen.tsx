import { useEffect, useState } from "react";

import { useApi, useSignInConfig } from "../api/context";
import type { AuthState } from "../api/contract";
import { endSession } from "../api/end-session";
import { Avatar } from "../components/Avatar";
import { SignInMode, SignInPanel } from "../components/SignIn";
import { Button, IconButton } from "../components/ui/Button";
import { Chip } from "../components/ui/Chip";
import { Dialog } from "../components/ui/Dialog";
import { Menu } from "../components/ui/Menu";
import { Status } from "../components/ui/Status";
import { Banner } from "../components/ui/Surfaces";
import { demoUrl } from "../demo";
import { Icon, IconName } from "../icons";
import { DemoBadge, SpawnpointMark } from "../shell/AppBar";
import { useAppearance } from "../shell/hooks";
import { rich, t } from "../i18n";

const CONSOLE_HASH = "#/worlds";

// The front door: the console's own chrome, the console itself as the proof.
// Signing in lives in the app bar; a signed-in person sees their avatar there.
// One place names the three modes; the dialog titles itself from it.
const SIGN_IN_TITLE: Record<SignInMode, string> = {
  "sign-in": t("common.sign"),
  register: t("landing.createAccount"),
  forgot: t("landing.resetPassword"),
};

export function LandingScreen({ auth, onChange }: Readonly<{ auth: AuthState; onChange: (state: AuthState) => void }>) {
  const api = useApi();
  const signInConfig = useSignInConfig();
  const { theme, cycle, label } = useAppearance();
  const configured = signInConfig.configured;
  const session = auth.status === "authenticated" && auth.session.state === "active" ? auth.session : null;
  const visitor = auth.status === "authenticated" && auth.session.state === "visitor" ? auth.session : null;
  const [signIn, setSignIn] = useState<SignInMode | null>(null);
  const [passwordRegistrationOffered, setPasswordRegistrationOffered] = useState(false);
  const signedOut = !session && !visitor && auth.status !== "loading";

  useEffect(() => {
    if (!signedOut || !configured) return;
    let active = true;
    void api.loadLoginOptions().then((options) => {
      if (active) setPasswordRegistrationOffered(options.selfRegistration.includes("password"));
    });
    return () => { active = false; };
  }, [configured, signedOut]);

  return (
    <div className="landing-shell">
      <header className="appbar landing-bar">
        <a className="appbar-brand" href="#/">
          <SpawnpointMark />
          <strong>Spawnpoint</strong>
        </a>
        <span className="appbar-spacer" />
        <div className="appbar-actions">
          {session?.demo === true && <DemoBadge />}
          <IconButton icon={theme === "dark" ? "light_mode" : "dark_mode"} label={t("landing.labelChangeTheme", { label })} onClick={cycle} />
          {auth.status === "loading" && <span aria-hidden="true" className="avatar landing-avatar-pending" />}
          {session && (
            <Menu
              avatar={{ name: session.identity.displayName, photoUrl: session.profile.photoUrl }}
              items={[
                { id: "console", label: t("landing.openConsole"), detail: session.role?.name ?? undefined, icon: "public", onSelect: () => { window.location.hash = CONSOLE_HASH; } },
                { id: "profile", label: t("common.profile"), icon: "person", onSelect: () => { window.location.hash = "#/profile"; } },
                "separator",
                { id: "signout", label: t("common.signOut"), icon: "logout", onSelect: () => void endSession(api) },
              ]}
              label={t("landing.identityDisplayNameAccountMenu", { identityDisplayName: session.identity.displayName })}
            />
          )}
          {visitor && (
            <Menu
              avatar={{ name: visitor.candidate.displayName, photoUrl: visitor.candidate.photoUrl }}
              items={[
                { id: "request", label: visitor.candidate.status === "REQUESTED" ? t("common.accessRequested") : t("common.requestAccess"), detail: t("landing.signedInNoRole", { provider: visitor.candidate.provider === "password" ? t("landing.providerEmail") : "Telegram" }), icon: "person_add", onSelect: () => { window.location.hash = CONSOLE_HASH; } },
                "separator",
                { id: "signout", label: t("common.signOut"), icon: "logout", onSelect: () => void endSession(api) },
              ]}
              label={t("landing.identityDisplayNameAccountMenu", { identityDisplayName: visitor.candidate.displayName })}
            />
          )}
          {signedOut && (configured
            ? <Button icon="login" onClick={() => setSignIn("sign-in")} variant="filled">{t("common.sign")}</Button>
            : <Button disabled icon="login" title={t("landing.deploymentHasNoAccess")} variant="filled">{t("common.sign")}</Button>)}
        </div>
      </header>

      <Dialog
        brand={<><SpawnpointMark size={32} /><strong>Spawnpoint</strong></>}
        className="signin-dialog"
        onClose={() => setSignIn(null)}
        open={signIn !== null}
        title={SIGN_IN_TITLE[signIn ?? "sign-in"]}
      >
        {signIn !== null && <SignInPanel initialMode={signIn} onChange={(state) => { setSignIn(null); onChange(state); }} onModeChange={setSignIn} />}
      </Dialog>

      <main className="landing" id="main">
        <section className="landing-hero">
          <div className="landing-copy">
            <h1>{t("landing.gameServersRunOnly")}</h1>
            <p className="landing-lead">
              {t("landing.spawnpointKeepsGroupsGame")}
            </p>
            <div className="landing-links">
              {session && <a className="landing-link" href={CONSOLE_HASH}>{t("landing.openConsole")}<Icon name="chevron_right" size={18} /></a>}
              {signedOut && configured && passwordRegistrationOffered && <button className="landing-link" onClick={() => setSignIn("register")} type="button">{t("common.createAccount")}<Icon name="chevron_right" size={18} /></button>}
              <a className="landing-link" href={demoUrl()}>{t("landing.tryDemo")}<Icon name="chevron_right" size={18} /></a>
              <a className="landing-link" href="#what-the-console-does">{t("landing.whatConsoleDoes")}<Icon name="chevron_right" size={18} /></a>
            </div>
            {auth.status === "error" && <Banner actions={<Button onClick={() => onChange({ status: "signed-out" })} variant="text">{t("common.dismiss")}</Button>} description={auth.message} title={t("landing.signInDidNotComplete")} tone="error" />}
          </div>
          <ConsoleShot />
        </section>

        <section aria-labelledby="what-the-console-does-title" className="landing-section" id="what-the-console-does">
          <h2 id="what-the-console-does-title">{t("landing.whatConsoleDoes")}</h2>
          <dl className="landing-facts">
            <Fact icon="public" title={t("landing.gamesWorlds")}>
              {t("landing.everyGameHasOwn")}
            </Fact>
            <Fact icon="play_arrow" title={t("landing.oneHostStartedDemand")}>
              {t("landing.oneSharedAWSHost")}
            </Fact>
            <Fact icon="backup" title={t("landing.backupsWipesRestores")}>
              {t("landing.everyStopLeavesVerified")}
            </Fact>
            <Fact icon="inventory" title={t("landing.buildsFromGit")}>
              {t("landing.serverPresetsAuthoredGit")}
            </Fact>
            <Fact icon="download" title={t("landing.clientPacksMods")}>
              {t("landing.downloadClientPackMatches")}
            </Fact>
            <Fact icon="send" title={t("landing.invitationsTelegram")}>
              {t("landing.inviteWholeGroupChat")}
            </Fact>
            <Fact icon="terminal" title={t("landing.consoleMetrics")}>
              {t("landing.rCONConsoleRecordsWho")}
            </Fact>
          </dl>
        </section>
      </main>

      <footer className="landing-footer">
        <span><SpawnpointMark size={20} /> Spawnpoint</span>
        <span>{t("landing.aWSControlPlanePrivate")}</span>
      </footer>
    </div>
  );
}

function Fact({ icon, title, children }: Readonly<{ icon: IconName; title: string; children: React.ReactNode }>) {
  return (
    <div>
      <dt><Icon name={icon} size={20} />{title}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// The example records in the still: names and addresses, which stay as they are in every language.
const SHOT = {
  owner: "DrArzter",
  instanceType: "m7i-flex.large",
  address: "172.29.23.24:25565",
  worlds: [
    { world: "Rostik", worldId: "minecraft-rostik-12345678", release: "Industrial 1.2" },
    { world: "Vanilla", worldId: "vanilla", release: "Release 1.21" },
  ],
} as const;

// A still of the console built from its own components with example records;
// no control inside it works, and the caption says so.
function ConsoleShot() {
  return (
    <figure aria-label={t("landing.exampleConsoleMinecraftOnline")} className="shot">
      <div aria-hidden="true" className="shot-frame">
        <div className="shot-bar">
          <span className="shot-mark"><SpawnpointMark size={22} /></span>
          <span className="shot-scope"><Icon name="sports_esports" size={16} />Minecraft<Icon name="unfold_more" size={14} /></span>
          <Avatar className="shot-avatar" name={SHOT.owner} size="small" />
        </div>
        <div className="shot-body">
          <div className="shot-title">{t("common.worlds")}</div>
          <div className="card shot-session">
            <div className="shot-session-state">
              <Status kind="ok" label={t("landing.minecraftOnline")} size="large" />
              <span className="shot-pair">{rich("landing.shotDesired", { state: <strong>{t("landing.shotRunning")}</strong> })}<Icon name="chevron_right" size={14} />{rich("world.observedAt", { time: <strong>{t("landing.shotReady")}</strong> })}</span>
            </div>
            <dl className="shot-facts">
              <div><dt>{t("common.computeHost")}</dt><dd><Status kind="ok" label={t("landing.sharedGameHost")} /></dd></div>
              <div><dt>{t("common.instanceType")}</dt><dd><code>{SHOT.instanceType}</code></dd></div>
            </dl>
          </div>
          <div className="card shot-table">
            <div className="shot-row shot-head"><span>{t("common.status")}</span><span>{t("common.name")}</span><span>{t("common.release")}</span><span>{t("common.address")}</span><span /></div>
            {SHOT.worlds.map((row) => <div className="shot-row" key={row.worldId}><Status kind="ready" label={t("common.ready")} /><span><strong>{row.world}</strong><small>{row.worldId}</small></span><span>{row.release}</span><code>{SHOT.address}</code><span className="shot-action"><Icon name="stop" size={16} />{t("common.stop")}</span></div>)}
          </div>
        </div>
      </div>
      <figcaption><Chip tone="tonal">{t("landing.exampleData")}</Chip><span>{t("landing.worldsPageAsPlayer")}</span></figcaption>
    </figure>
  );
}
