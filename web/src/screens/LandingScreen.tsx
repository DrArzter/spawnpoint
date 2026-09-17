import { useState } from "react";

import { authConfigured, AuthState, endSession } from "../auth";
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

const CONSOLE_HASH = "#/worlds";

// The front door: the console's own chrome, the console itself as the proof.
// Signing in lives in the app bar; a signed-in person sees their avatar there.
export function LandingScreen({ auth, onChange }: Readonly<{ auth: AuthState; onChange: (state: AuthState) => void }>) {
  const { theme, cycle, label } = useAppearance();
  const configured = authConfigured();
  const session = auth.status === "authenticated" && auth.session.state === "active" ? auth.session : null;
  const visitor = auth.status === "authenticated" && auth.session.state === "visitor" ? auth.session : null;
  const [signIn, setSignIn] = useState<SignInMode | null>(null);
  const signedOut = !session && !visitor && auth.status !== "loading";

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
          <IconButton icon={theme === "dark" ? "light_mode" : "dark_mode"} label={`${label}. Change theme`} onClick={cycle} />
          {auth.status === "loading" && <span aria-hidden="true" className="avatar landing-avatar-pending" />}
          {session && (
            <Menu
              avatar={{ name: session.identity.displayName, photoUrl: session.profile.photoUrl }}
              items={[
                { id: "console", label: "Open the console", detail: session.role?.name ?? undefined, icon: "public", onSelect: () => { window.location.hash = CONSOLE_HASH; } },
                { id: "profile", label: "Profile", icon: "person", onSelect: () => { window.location.hash = "#/profile"; } },
                "separator",
                { id: "signout", label: "Sign out", icon: "logout", onSelect: () => void endSession() },
              ]}
              label={`${session.identity.displayName}: account menu`}
            />
          )}
          {visitor && (
            <Menu
              avatar={{ name: visitor.candidate.displayName, photoUrl: visitor.candidate.photoUrl }}
              items={[
                { id: "request", label: visitor.candidate.status === "REQUESTED" ? "Access requested" : "Request access", detail: `Signed in with ${visitor.candidate.provider === "password" ? "email" : "Telegram"}, no role yet`, icon: "person_add", onSelect: () => { window.location.hash = CONSOLE_HASH; } },
                "separator",
                { id: "signout", label: "Sign out", icon: "logout", onSelect: () => void endSession() },
              ]}
              label={`${visitor.candidate.displayName}: account menu`}
            />
          )}
          {signedOut && (configured
            ? <Button icon="login" onClick={() => setSignIn("sign-in")} variant="filled">Sign in</Button>
            : <Button disabled icon="login" title="This deployment has no access API URL" variant="filled">Sign in</Button>)}
        </div>
      </header>

      <Dialog onClose={() => setSignIn(null)} open={signIn !== null} title={signIn === "register" ? "Create your Spawnpoint account" : "Sign in to Spawnpoint"}>
        {signIn !== null && <SignInPanel initialMode={signIn} onChange={(state) => { setSignIn(null); onChange(state); }} />}
      </Dialog>

      <main className="landing" id="main">
        <section className="landing-hero">
          <div className="landing-copy">
            <h1>Game servers that run only while someone plays.</h1>
            <p className="landing-lead">
              Spawnpoint keeps the group's game worlds on one shared AWS host. Start a world from Telegram or from this console; stopping saves it, takes a verified backup and shuts the host down, so nothing runs while nobody plays.
            </p>
            <div className="landing-links">
              {session && <a className="landing-link" href={CONSOLE_HASH}>Open the console<Icon name="chevron_right" size={18} /></a>}
              {signedOut && configured && <button className="landing-link" onClick={() => setSignIn("register")} type="button">Create an account<Icon name="chevron_right" size={18} /></button>}
              <a className="landing-link" href={demoUrl()}>Try the demo<Icon name="chevron_right" size={18} /></a>
              <a className="landing-link" href="#what-the-console-does">What the console does<Icon name="chevron_right" size={18} /></a>
            </div>
            {auth.status === "error" && <Banner actions={<Button onClick={() => onChange({ status: "signed-out" })} variant="text">Dismiss</Button>} description={auth.message} title="Sign-in did not complete" tone="error" />}
          </div>
          <ConsoleShot />
        </section>

        <section aria-labelledby="what-the-console-does-title" className="landing-section" id="what-the-console-does">
          <h2 id="what-the-console-does-title">What the console does</h2>
          <dl className="landing-facts">
            <Fact icon="public" title="Games and worlds">
              Every game has its own presets and worlds. Pick the game, pick the world, read where to connect and who is online.
            </Fact>
            <Fact icon="play_arrow" title="One host, started on demand">
              One shared AWS host runs one session at a time. Start boots it with the world you chose; Stop refuses while players are online, then saves, backs up and powers the host down. Desired state sits next to observed state, so you always see what is really running.
            </Fact>
            <Fact icon="backup" title="Backups, wipes and restores">
              Every stop leaves a verified archive in S3, checksummed and listed per wipe. A new wipe or a restore opens a new generation of the world; nothing is ever overwritten.
            </Fact>
            <Fact icon="inventory" title="Builds from Git">
              Server presets are authored in Git and built into immutable releases. A save runs exactly one release and can be moved to the next one on purpose, never by accident.
            </Fact>
            <Fact icon="download" title="Client packs and mods">
              Download the client pack that matches the release a world runs, so your game joins with the right mods first time. Links are signed and short-lived.
            </Fact>
            <Fact icon="send" title="Invitations in Telegram">
              Invite the whole group chat or specific players when a world is up, and see whether the message was delivered.
            </Fact>
            <Fact icon="terminal" title="Console and metrics">
              An RCON console that records who ran what, and session metrics next to it. Both pages are in the panel; the RCON gateway and the metrics feed are the next slices to land.
            </Fact>
          </dl>
        </section>
      </main>

      <footer className="landing-footer">
        <span><SpawnpointMark size={20} /> Spawnpoint</span>
        <span>An AWS control plane for a private gaming group. The Telegram bot, the Mini App and this console drive the same worlds.</span>
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

// A still of the console built from its own components with example records;
// no control inside it works, and the caption says so.
function ConsoleShot() {
  return (
    <figure aria-label="Example of the console: Minecraft online on the shared host, two worlds ready with their addresses, Stop available on each row" className="shot">
      <div aria-hidden="true" className="shot-frame">
        <div className="shot-bar">
          <span className="shot-mark"><SpawnpointMark size={22} /></span>
          <span className="shot-scope"><Icon name="sports_esports" size={16} />Minecraft<Icon name="unfold_more" size={14} /></span>
          <Avatar className="shot-avatar" name="DrArzter" size="small" />
        </div>
        <div className="shot-body">
          <div className="shot-title">Worlds</div>
          <div className="card shot-session">
            <div className="shot-session-state">
              <Status kind="ok" label="Minecraft online" size="large" />
              <span className="shot-pair">Desired <strong>running</strong><Icon name="chevron_right" size={14} />observed <strong>ready</strong></span>
            </div>
            <dl className="shot-facts">
              <div><dt>Compute host</dt><dd><Status kind="ok" label="Shared game host" /></dd></div>
              <div><dt>Instance type</dt><dd><code>m7i-flex.large</code></dd></div>
            </dl>
          </div>
          <div className="card shot-table">
            <div className="shot-row shot-head"><span>Status</span><span>Name</span><span>Release</span><span>Address</span><span /></div>
            <div className="shot-row"><Status kind="ready" label="Ready" /><span><strong>Rostik</strong><small>minecraft-rostik-12345678</small></span><span>Industrial 1.2</span><code>172.29.23.24:25565</code><span className="shot-action"><Icon name="stop" size={16} />Stop</span></div>
            <div className="shot-row"><Status kind="ready" label="Ready" /><span><strong>Vanilla</strong><small>vanilla</small></span><span>Release 1.21</span><code>172.29.23.24:25565</code><span className="shot-action"><Icon name="stop" size={16} />Stop</span></div>
          </div>
        </div>
      </div>
      <figcaption><Chip tone="tonal">Example data</Chip><span>The Worlds page as a player sees it.</span></figcaption>
    </figure>
  );
}
