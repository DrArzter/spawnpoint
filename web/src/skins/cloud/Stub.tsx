import type { ReactNode } from "react";

import { actionsOf, type Action } from "../../core/actions";
import { ActionButton } from "./ui/ActionButton";
import { Card } from "./ui/Card";
import { PageHeader, type Crumb } from "./ui/PageHeader";

/*
 * S1 stand-ins for the pages S3–S7 build. Each draws every Action its model
 * holds, so the skin contract passes before the pages exist. A page slice
 * replaces its stub file and drops its use of this module; S9 deletes it.
 */

export function ActionList({ actions }: Readonly<{ actions: readonly Action[] }>) {
  const unique = [...new Set(actions)];
  return <div className="c-stub-actions">{unique.map((item, index) => <ActionButton action={item} key={`${item.id}:${index}`} size="sm" />)}</div>;
}

export function StubPage({ title, trail, after, model, more = [], children }: Readonly<{
  title: string;
  trail?: readonly Crumb[];
  after?: ReactNode;
  model: unknown;
  /** Actions a model hands out through functions, asked for here. */
  more?: readonly Action[];
  children?: ReactNode;
}>) {
  return (
    <div className="c-page">
      <PageHeader after={after} title={title} trail={trail} />
      {children}
      <Card label="Actions">
        <ActionList actions={[...actionsOf(model), ...more]} />
      </Card>
    </div>
  );
}
