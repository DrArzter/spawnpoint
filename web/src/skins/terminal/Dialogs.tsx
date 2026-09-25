import { useEffect, useState } from "react";

import { Timestamp } from "../../components/ui/Timestamp";
import type { ConfirmationModel, ConnectionFieldsModel, CreateWorldModel, InvitationModel, ScopeModel, WorldSettingsModel } from "../../core/models";
import { plural } from "../../lib/format";
import { Avatar, Drawer, Empty, Field, Key, Modal, Notice, SelectInput, State, TextInput, Verb, Wait } from "./ui";

// The scope picker: choosing a game re-scopes the whole console.
export function ScopeDialog({ model }: Readonly<{ model: ScopeModel }>) {
  const [query, setQuery] = useState("");
  useEffect(() => { if (model.open) setQuery(""); }, [model.open]);
  const needle = query.trim().toLocaleLowerCase();
  const visible = model.games.filter((game) => needle === "" || game.displayName.toLocaleLowerCase().includes(needle) || game.code.toLocaleLowerCase().includes(needle) || game.id.includes(needle));
  return (
    <Modal className="t-scope-modal" onClose={model.close.run} open={model.open} title="Select a game" verbs={<Verb action={model.close} />}>
      <Field hideLabel label="Search games">
        <TextInput autoComplete="off" data-autofocus onChange={(event) => setQuery(event.target.value)} placeholder="Search games" type="search" value={query} />
      </Field>
      <div aria-label="Games" className="t-scope-list" role="listbox">
        {visible.map((game) => {
          const status = model.statusOf(game);
          return (
            <button aria-selected={game.id === model.game?.id} className="t-scope-row" data-action="scope.select" key={game.id} onClick={() => model.select(game.id)} role="option" type="button">
              <span aria-hidden="true" className="t-scope-code">{game.code}</span>
              <span className="t-stack">
                <strong>{game.displayName}</strong>
                <small>{plural(game.worlds.length, "world")} · {plural(game.presets.length, "preset")}</small>
              </span>
              <State kind={status.kind} label={status.label} />
            </button>
          );
        })}
      </div>
      {visible.length === 0 && <Empty description={`Nothing matches "${query}".`} title="No matching games" verbs={<Key label="Clear search" onClick={() => setQuery("")} size="small" />} />}
    </Modal>
  );
}

export function ConfirmationDialog({ model }: Readonly<{ model: ConfirmationModel | null }>) {
  if (model === null) return <Modal onClose={() => undefined} open={false} title="" />;
  return (
    <Modal
      dismissOnBackdrop={false}
      onClose={model.cancel.run}
      open
      title={model.title}
      verbs={<>
        <Verb action={model.cancel} />
        <Verb action={model.confirm} tone={model.destructive ? "danger" : "primary"} />
      </>}
    >
      <p className="t-copy-line">{model.description}</p>
      {model.releaseChoice && (
        <Field label="Release for the new wipe">
          <SelectInput onChange={(event) => model.releaseChoice?.set(event.target.value)} value={model.releaseChoice.value}>
            <option disabled value="">Choose a release</option>
            {model.releaseChoice.options.map((option) => <option key={option.version} value={option.version}>{option.version}{option.latest ? " (latest)" : ""}</option>)}
          </SelectInput>
        </Field>
      )}
      {model.typedConfirmation && <>
        <p className="t-copy-line">Type <code>{model.typedConfirmation.expected}</code> to confirm.</p>
        <Field label="World ID">
          <TextInput autoComplete="off" data-autofocus mono onChange={(event) => model.typedConfirmation?.set(event.target.value)} placeholder={model.typedConfirmation.expected} value={model.typedConfirmation.value} />
        </Field>
      </>}
    </Modal>
  );
}

function ConnectionFields({ model }: Readonly<{ model: ConnectionFieldsModel }>) {
  return <>
    <Field hint="Choose where this world's server starts." label="Hosting">
      <SelectInput onChange={(event) => model.setPlacement(event.target.value as "configured" | "fleet")} value={model.placement}>
        <option value="configured">Persistent host · ZeroTier</option>
        <option disabled={!model.fleetAvailable} value="fleet">On-demand fleet · public connection{model.fleetAvailable ? "" : " (not configured)"}</option>
      </SelectInput>
    </Field>
    {model.placement === "fleet" && <Field hint="Fleet machines are disposable and never join ZeroTier." label="Connection">
      <SelectInput onChange={(event) => model.setConnectivity(event.target.value as "raw" | "route53")} value={model.connectivity}>
        <option value="raw">Public IP and game port</option>
        {model.dnsAvailable && <option value="route53">Public DNS</option>}
      </SelectInput>
    </Field>}
    {model.placement === "fleet" && <p className="t-copy-line">The game port is public. Set the game's password or allowlist yourself before sharing its address.</p>}
  </>;
}

export function CreateWorldSheet({ model }: Readonly<{ model: CreateWorldModel }>) {
  const readyPresets = model.presets.filter((preset) => preset.buildStatus === "ready");
  return (
    <Drawer
      closeActionId={model.cancel.id}
      description={`A new world opens wipe #1 from an immutable ${model.game.displayName} release.`}
      footer={<>
        <p>{model.preset ? `${model.preset.displayName} · ${plural(model.preset.releases.length, "release")}` : "Choose a preset"}</p>
        <Verb action={model.submit} tone="primary" />
      </>}
      onClose={model.cancel.run}
      open
      title="Create world"
    >
      <form className="t-form" onSubmit={(event) => { event.preventDefault(); model.submit.run(); }}>
        <Field hint={readyPresets.length === 0 ? "No preset of this game has a ready release." : undefined} label="Preset">
          <SelectInput onChange={(event) => model.setPresetId(event.target.value)} value={model.presetId}>
            {model.presets.map((item) => <option disabled={item.buildStatus !== "ready"} key={item.id} value={item.id}>{item.displayName}{item.buildStatus !== "ready" ? ` (${item.buildStatus})` : ""}</option>)}
          </SelectInput>
        </Field>
        <Field hint="1 to 80 characters. Shown in the worlds list and in Telegram." label="Name">
          <TextInput autoComplete="off" data-autofocus maxLength={80} onChange={(event) => model.setName(event.target.value)} placeholder="For example, Rail world" value={model.name} />
        </Field>
        <Field label="Release">
          <SelectInput disabled={!model.preset} onChange={(event) => model.setRelease(event.target.value)} value={model.release}>
            <option disabled value="">Choose a release</option>
            {model.preset && [...model.preset.releases].reverse().map((version) => <option key={version} value={version}>{version}{version === model.preset?.latestRelease ? " (latest)" : ""}</option>)}
          </SelectInput>
        </Field>
        <ConnectionFields model={model.connection} />
      </form>
    </Drawer>
  );
}

export function WorldSettingsSheet({ model }: Readonly<{ model: WorldSettingsModel }>) {
  return (
    <Drawer
      description={`Choose how ${model.world.displayName} is hosted and reached. Changes are allowed only while the world is stopped.`}
      footer={<><Verb action={model.cancel} /><Verb action={model.save} tone="primary" /></>}
      onClose={model.cancel.run}
      open
      title={`Hosting · ${model.game.displayName}`}
    >
      <div className="t-form">
        {!model.stopped && <p className="t-copy-line">Stop this game's current session before changing hosting.</p>}
        <ConnectionFields model={model.connection} />
      </div>
    </Drawer>
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
    <Drawer
      closeActionId={model.close.id}
      description={`${game.displayName} · ${world.displayName}${address}`}
      footer={<>
        <p>{model.send.hint}</p>
        <Verb action={model.send} tone="primary" />
      </>}
      onClose={model.close.run}
      open
      title="Invite players"
    >
      <div className="t-form">
        <fieldset className="t-radios">
          <legend className="t-setting-label">Audience</legend>
          <label className="t-radio">
            <input checked={model.audience === "broadcast"} name="invite-audience" onChange={() => model.setAudience("broadcast")} type="radio" />
            <span aria-hidden="true" className="t-radio-box">{model.audience === "broadcast" ? "(o)" : "( )"}</span>
            <span className="t-stack"><strong>Everyone</strong><small>Group chats and people subscribed to broadcast invitations. Your own chat is excluded.</small></span>
          </label>
          <label className="t-radio">
            <input checked={model.audience === "direct"} name="invite-audience" onChange={() => model.setAudience("direct")} type="radio" />
            <span aria-hidden="true" className="t-radio-box">{model.audience === "direct" ? "(o)" : "( )"}</span>
            <span className="t-stack"><strong>Specific people</strong><small>Only the selected people, if they allow direct invitations.</small></span>
          </label>
        </fieldset>

        {model.audience === "direct" && (
          <section aria-label="Players" className="t-form">
            <Field hideLabel label="Find a player">
              <TextInput autoComplete="off" onChange={(event) => model.setQuery(event.target.value)} placeholder="Search by display name" type="search" value={model.query} />
            </Field>
            <p className="t-copy-line t-inline">
              <span>{summary}</span>
              {model.selectedCount > 0 && <Verb action={model.clearSelection} size="small" />}
            </p>
            {recipients.status === "loading" && <Wait label="Loading approved players" />}
            {recipients.status === "error" && <Notice title="Players could not be loaded" tone="error" verbs={<Verb action={recipients.retry} size="small" />} />}
            {recipients.status === "ready" && recipients.value.length === 0 && !model.query.trim() && <Empty description="Approve another player in Access before sending a direct invitation." title="No other approved players" />}
            {recipients.status === "ready" && recipients.value.length === 0 && model.query.trim() && <Empty description={`Nothing matches "${model.query}".`} title="No matching players" verbs={<Key label="Clear search" onClick={() => model.setQuery("")} size="small" />} />}
            {recipients.status === "ready" && recipients.value.length > 0 && (
              <ul className="t-list">
                {recipients.value.map((recipient) => (
                  <li className="t-list-row" key={recipient.id}>
                    <label className={recipient.ready ? "t-check" : "t-check t-check-off"}>
                      <input checked={recipient.selected} disabled={!recipient.ready} onChange={recipient.toggle} type="checkbox" />
                      <span aria-hidden="true" className="t-check-box">{recipient.selected ? "[x]" : "[ ]"}</span>
                      <Avatar name={recipient.displayName} photoUrl={recipient.photoUrl} />
                      <span className="t-stack"><strong>{recipient.displayName}</strong><small>{recipient.delivery}</small></span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section aria-labelledby="t-invite-history" className="t-details-group">
          <div className="t-group-head">
            <h3 className="t-group-name" id="t-invite-history">Recent invitations</h3>
            <Verb action={model.refreshHistory} size="small" />
          </div>
          {history.status === "loading" && <Wait label="Loading recent invitation results" />}
          {history.status === "error" && <Notice title="Delivery history could not be loaded" tone="error" verbs={<Verb action={history.retry} size="small" />} />}
          {history.status === "ready" && history.value.length === 0 && <p className="t-copy-line">No invitations sent for this world yet.</p>}
          {history.status === "ready" && history.value.length > 0 && (
            <ul className="t-list">
              {history.value.map((item) => (
                <li className="t-list-row t-history-row" key={item.id}>
                  <State kind={item.status.kind} label={item.status.label} />
                  <span className="t-tag">{item.audience}</span>
                  <span className="t-copy-line">{item.detail}</span>
                  <Timestamp className="t-secondary" value={item.createdAt} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Drawer>
  );
}
