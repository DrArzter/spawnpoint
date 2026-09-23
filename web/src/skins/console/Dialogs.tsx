import { useEffect, useState } from "react";

import { Avatar } from "../../components/Avatar";
import { Chip } from "../../components/ui/Chip";
import { Dialog, Sheet } from "../../components/ui/Dialog";
import { SearchField, SelectField, TextField } from "../../components/ui/Fields";
import { NoMatches } from "../../components/ui/Filter";
import { SkeletonRows } from "../../components/ui/Skeleton";
import { Status } from "../../components/ui/Status";
import { Banner, EmptyState } from "../../components/ui/Surfaces";
import { Timestamp } from "../../components/ui/Timestamp";
import type { ConfirmationModel, ConnectionFieldsModel, CreateWorldModel, InvitationModel, ScopeModel, WorldSettingsModel } from "../../core/models";
import { plural } from "../../lib/format";
import { ActionButton } from "./actions";

// The scope picker: choosing a game re-scopes the whole console.
export function ScopeDialog({ model }: Readonly<{ model: ScopeModel }>) {
  const [query, setQuery] = useState("");
  useEffect(() => { if (model.open) setQuery(""); }, [model.open]);
  const needle = query.trim().toLocaleLowerCase();
  const visible = model.games.filter((game) => needle === "" || game.displayName.toLocaleLowerCase().includes(needle) || game.code.toLocaleLowerCase().includes(needle) || game.id.includes(needle));
  return (
    <Dialog actions={<ActionButton action={model.close} variant="text" />} className="scope-dialog" onClose={model.close.run} open={model.open} title="Select a game">
      <SearchField autoComplete="off" className="scope-search" data-autofocus label="Search games" onChange={(event) => setQuery(event.target.value)} placeholder="Search games" value={query} />
      <div aria-label="Games" className="scope-list" role="listbox">
        {visible.map((game) => {
          const status = model.statusOf(game);
          return (
            <button aria-selected={game.id === model.game?.id} className="scope-row" data-action="scope.select" key={game.id} onClick={() => model.select(game.id)} role="option" type="button">
              <span aria-hidden="true" className="scope-code">{game.code}</span>
              <span>
                <strong>{game.displayName}</strong>
                <small>{plural(game.worlds.length, "world")} · {plural(game.presets.length, "preset")}</small>
              </span>
              <Status kind={status.kind} label={status.label} />
            </button>
          );
        })}
      </div>
      {visible.length === 0 && <NoMatches filter={{ query, clear: () => setQuery("") }} icon="sports_esports" noun="games" />}
    </Dialog>
  );
}

export function ConfirmationDialog({ model }: Readonly<{ model: ConfirmationModel | null }>) {
  if (model === null) return <Dialog onClose={() => undefined} open={false} title="" />;
  return (
    <Dialog
      actions={<>
        <ActionButton action={model.cancel} variant="text" />
        <ActionButton action={model.confirm} variant="filled" />
      </>}
      dismissOnBackdrop={false}
      onClose={model.cancel.run}
      open
      title={model.title}
    >
      <p>{model.description}</p>
      {model.releaseChoice && (
        <SelectField label="Release for the new wipe" onChange={(event) => model.releaseChoice?.set(event.target.value)} value={model.releaseChoice.value}>
          <option disabled value="">Choose a release</option>
          {model.releaseChoice.options.map((option) => <option key={option.version} value={option.version}>{option.version}{option.latest ? " (latest)" : ""}</option>)}
        </SelectField>
      )}
      {model.typedConfirmation && <>
        <p className="confirm-note">Type <code>{model.typedConfirmation.expected}</code> to confirm.</p>
        <TextField autoComplete="off" data-autofocus label="World ID" mono onChange={(event) => model.typedConfirmation?.set(event.target.value)} placeholder={model.typedConfirmation.expected} value={model.typedConfirmation.value} />
      </>}
    </Dialog>
  );
}

function ConnectionFields({ model }: Readonly<{ model: ConnectionFieldsModel }>) {
  return <>
    <SelectField hint="Choose where this world's server starts." label="Hosting" onChange={(event) => model.setPlacement(event.target.value as "configured" | "fleet")} value={model.placement}>
      <option value="configured">Persistent host · ZeroTier</option>
      <option disabled={!model.fleetAvailable} value="fleet">On-demand fleet · public connection{model.fleetAvailable ? "" : " (not configured)"}</option>
    </SelectField>
    {model.placement === "fleet" && <SelectField hint="Fleet machines are disposable and never join ZeroTier." label="Connection" onChange={(event) => model.setConnectivity(event.target.value as "raw" | "route53")} value={model.connectivity}>
      <option value="raw">Public IP and game port</option>
      {model.dnsAvailable && <option value="route53">Public DNS</option>}
    </SelectField>}
    {model.placement === "fleet" && <p className="secondary">The game port is public. Set the game's password or allowlist yourself before sharing its address.</p>}
  </>;
}

export function CreateWorldSheet({ model }: Readonly<{ model: CreateWorldModel }>) {
  const readyPresets = model.presets.filter((preset) => preset.buildStatus === "ready");
  return (
    <Sheet
      description={`A new world opens wipe #1 from an immutable ${model.game.displayName} release.`}
      footer={<>
        <p>{model.preset ? `${model.preset.displayName} · ${plural(model.preset.releases.length, "release")}` : "Choose a preset"}</p>
        <ActionButton action={model.submit} variant="filled" />
      </>}
      closeActionId={model.cancel.id}
      onClose={model.cancel.run}
      open
      title="Create world"
    >
      <form className="page" onSubmit={(event) => { event.preventDefault(); model.submit.run(); }}>
        <SelectField hint={readyPresets.length === 0 ? "No preset of this game has a ready release." : undefined} label="Preset" onChange={(event) => model.setPresetId(event.target.value)} value={model.presetId}>
          {model.presets.map((item) => <option disabled={item.buildStatus !== "ready"} key={item.id} value={item.id}>{item.displayName}{item.buildStatus !== "ready" ? ` (${item.buildStatus})` : ""}</option>)}
        </SelectField>
        <TextField autoComplete="off" data-autofocus hint="1 to 80 characters. Shown in the worlds list and in Telegram." label="Name" maxLength={80} onChange={(event) => model.setName(event.target.value)} placeholder="For example, Rail world" value={model.name} />
        <SelectField disabled={!model.preset} label="Release" onChange={(event) => model.setRelease(event.target.value)} value={model.release}>
          <option disabled value="">Choose a release</option>
          {model.preset && [...model.preset.releases].reverse().map((version) => <option key={version} value={version}>{version}{version === model.preset?.latestRelease ? " (latest)" : ""}</option>)}
        </SelectField>
        <ConnectionFields model={model.connection} />
      </form>
    </Sheet>
  );
}

export function WorldSettingsSheet({ model }: Readonly<{ model: WorldSettingsModel }>) {
  return (
    <Sheet
      description={`Choose how ${model.world.displayName} is hosted and reached. Changes are allowed only while the world is stopped.`}
      footer={<><ActionButton action={model.cancel} variant="text" /><ActionButton action={model.save} variant="filled" /></>}
      onClose={model.cancel.run}
      open
      title={`Hosting · ${model.game.displayName}`}
    >
      {!model.stopped && <p className="secondary">Stop this game's current session before changing hosting.</p>}
      <ConnectionFields model={model.connection} />
    </Sheet>
  );
}

export function InvitationSheet({ model }: Readonly<{ model: InvitationModel }>) {
  const { game, world } = model;
  const recipients = model.recipients;
  const history = model.history;
  const address = world.connectionAddress ? ` · ${world.connectionAddress}` : "";
  const matches = recipients.status === "ready" ? recipients.value.length : 0;
  const summary = model.query.trim() ? `${matches} matches` : `${model.reachable} reachable`;
  return (
    <Sheet
      description={`${game.displayName} · ${world.displayName}${address}`}
      footer={<>
        <p>{model.send.hint}</p>
        <ActionButton action={model.send} variant="filled" />
      </>}
      closeActionId={model.close.id}
      onClose={model.close.run}
      open
      title="Invite players"
    >
      <fieldset className="audience">
        <legend>Audience</legend>
        <label aria-label="Everyone" className="audience-option">
          <input checked={model.audience === "broadcast"} name="invite-audience" onChange={() => model.setAudience("broadcast")} type="radio" />
          <span><strong>Everyone</strong><small>Group chats and people subscribed to broadcast invitations. Your own chat is excluded.</small></span>
        </label>
        <label aria-label="Specific people" className="audience-option">
          <input checked={model.audience === "direct"} name="invite-audience" onChange={() => model.setAudience("direct")} type="radio" />
          <span><strong>Specific people</strong><small>Only the selected people, if they allow direct invitations.</small></span>
        </label>
      </fieldset>

      {model.audience === "direct" && (
        <section aria-label="Players" className="recipients">
          <SearchField autoComplete="off" label="Find a player" onChange={(event) => model.setQuery(event.target.value)} placeholder="Search by display name" value={model.query} />
          <p className="secondary recipients-summary">
            {summary}
            {model.selectedCount > 0 && <ActionButton action={model.clearSelection} size="small" variant="text" />}
          </p>
          {recipients.status === "loading" && <SkeletonRows label="Loading approved players" rows={3} />}
          {recipients.status === "error" && <Banner actions={<ActionButton action={recipients.retry} variant="text" />} title="Players could not be loaded" tone="error" />}
          {recipients.status === "ready" && recipients.value.length === 0 && !model.query.trim() && <EmptyState description="Approve another player in Access before sending a direct invitation." icon="group" title="No other approved players" />}
          {recipients.status === "ready" && recipients.value.length === 0 && model.query.trim() && <NoMatches filter={{ query: model.query, clear: () => model.setQuery("") }} icon="group" noun="players" />}
          {recipients.status === "ready" && recipients.value.length > 0 && (
            <ul className="recipient-list">
              {recipients.value.map((recipient) => (
                <li key={recipient.id}>
                  <label className={recipient.ready ? "recipient" : "recipient recipient-unavailable"}>
                    <input checked={recipient.selected} disabled={!recipient.ready} onChange={recipient.toggle} type="checkbox" />
                    <Avatar name={recipient.displayName} photoUrl={recipient.photoUrl} />
                    <span><strong>{recipient.displayName}</strong><small>{recipient.delivery}</small></span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section aria-labelledby="invite-history-title" className="invite-history">
        <header>
          <h3 id="invite-history-title">Recent invitations</h3>
          <ActionButton action={model.refreshHistory} size="small" variant="text" />
        </header>
        {history.status === "loading" && <SkeletonRows label="Loading recent invitation results" rows={2} />}
        {history.status === "error" && <Banner actions={<ActionButton action={history.retry} variant="text" />} title="Delivery history could not be loaded" tone="error" />}
        {history.status === "ready" && history.value.length === 0 && <p className="secondary">No invitations sent for this world yet.</p>}
        {history.status === "ready" && history.value.length > 0 && (
          <ul className="history-list">
            {history.value.map((item) => (
              <li key={item.id}>
                <Status kind={item.status.kind} label={item.status.label} />
                <span><Chip tone="tonal">{item.audience}</Chip></span>
                <span className="secondary history-detail">{item.detail}</span>
                <Timestamp className="secondary" value={item.createdAt} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </Sheet>
  );
}
