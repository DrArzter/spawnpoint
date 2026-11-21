import type { FormEvent } from "react";

import type { WhitelistModel } from "../../../core/models";
import { cx } from "../../../lib/cx";
import { ActionButton } from "../ui/ActionButton";
import { Card } from "../ui/Card";
import { shortDateTime } from "../ui/DetailList";
import { Empty, LoadError } from "../ui/Empty";
import { TextInput } from "../ui/Fields";
import { Grid } from "../ui/Grid";
import { Skeleton, SkeletonGroup } from "../ui/Skeleton";
import { ARRIVED, useArrivals } from "../ui/Tick";

export function WhitelistTab({ model }: Readonly<{ model: WhitelistModel }>) {
  const list = model.list;
  const ready = list.status === "ready" ? list.value : null;
  const fresh = useArrivals(ready?.rows.map((row) => row.name) ?? []);
  const changed = ready?.updatedAt ? [`Changed ${shortDateTime(ready.updatedAt) ?? ""}`, ready.updatedBy ? `by ${ready.updatedBy}` : null].filter(Boolean).join(" ") : undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!model.add.disabled && !model.add.busy) model.add.run();
  };
  const form = (
    <form className="c-wl-form" onSubmit={submit}>
      <TextInput
        aria-invalid={model.draftError ? true : undefined}
        aria-label="Player name"
        autoComplete="off"
        data-tip={model.draftError ?? undefined}
        mono
        onChange={(event) => model.setDraft(event.target.value)}
        placeholder="Player name"
        value={model.draft}
      />
      <ActionButton action={model.add} size="sm" />
    </form>
  );
  return (
    <Card actions={form} body="flush" count={ready?.rows.length} title="Whitelist" titleTip={changed}>
      {list.status === "error" && <LoadError error={list.error} kind={list.kind} retry={list.retry} title="Whitelist could not be loaded" verb="read the whitelist" />}
      {list.status === "loading" && (
        <SkeletonGroup className="c-wl-names">
          {[0, 1, 2].map((cell) => <Skeleton height={44} key={cell} />)}
        </SkeletonGroup>
      )}
      {ready && ready.rows.length === 0 && <Empty icon="verified_user" title={ready.managed ? "Nobody can join" : "No names"} />}
      {ready && ready.rows.length > 0 && (
        <Grid className="c-wl-names" kind="name" label="Players">
          {ready.rows.map((row) => (
            <div className={cx("c-wl-name", fresh.has(row.name) && ARRIVED)} key={row.name}>
              <span className="c-mono" title={row.name}>{row.name}</span>
              <ActionButton action={{ ...row.remove, label: `Remove ${row.name}` }} iconOnly size="sm" />
            </div>
          ))}
        </Grid>
      )}
    </Card>
  );
}
