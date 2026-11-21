import type { BootModel } from "../../core/models";
import { Mark } from "./ui/Frame";
import { ProgressBar } from "./ui/ProgressBar";

// The console's first load: the mark, the title and a travelling bar. The
// frame is not drawn yet; the first page renders with its own loading regions.
export function Boot({ model }: Readonly<{ model: BootModel }>) {
  return (
    <main aria-busy="true" aria-live="polite" className="c-boot" role="status">
      <section className="c-boot-card">
        <Mark />
        <h1>{model.title}</h1>
        <ProgressBar label={model.title} />
      </section>
    </main>
  );
}
