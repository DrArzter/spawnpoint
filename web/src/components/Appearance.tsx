import { useMemo, useState } from "react";

import { updateAppearance } from "../auth";
import { deriveAccent, DEFAULT_ACCENT, parseHex } from "../styles/accent";
import type { ThemePreference } from "../telegram";
import { Button } from "./ui/Button";
import { ChoiceChip } from "./ui/Chip";
import { TextField } from "./ui/Fields";
import { useSnackbar } from "./ui/Snackbar";
import { Card } from "./ui/Surfaces";

type Appearance = {
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
  theme: "light" | "dark";
  accent: string;
  setAccent: (next: string) => void;
};

const THEMES: readonly { id: ThemePreference; label: string; icon: "brightness_auto" | "light_mode" | "dark_mode" }[] = [
  { id: "system", label: "System", icon: "brightness_auto" },
  { id: "light", label: "Light", icon: "light_mode" },
  { id: "dark", label: "Dark", icon: "dark_mode" },
];

/** A starting point, not a limit: the field below takes any colour. */
const SUGGESTED: readonly { name: string; colour: string }[] = [
  { name: "Blue", colour: "#1a73e8" },
  { name: "Green", colour: "#1e8e3e" },
  { name: "Purple", colour: "#8430ce" },
  { name: "Red", colour: "#d93025" },
  { name: "Orange", colour: "#e8710a" },
  { name: "Teal", colour: "#00838f" },
  { name: "Pink", colour: "#c2185b" },
  { name: "Grey", colour: "#5f5f5f" },
];

export function Appearance({ appearance }: { appearance: Appearance }) {
  const notify = useSnackbar();
  const [draft, setDraft] = useState(appearance.accent);

  // What the panel would actually paint, so the note below describes the
  // colour in use rather than the colour that was typed.
  const derived = useMemo(() => deriveAccent(appearance.accent, appearance.theme), [appearance.accent, appearance.theme]);

  function save(next: { theme?: ThemePreference; accent?: string }) {
    const theme = next.theme ?? appearance.preference;
    const accent = next.accent ?? appearance.accent;
    if (next.theme) appearance.setPreference(next.theme);
    if (next.accent) appearance.setAccent(next.accent);
    // The panel has already repainted. Storing is what makes the choice follow
    // the person to another device, so only that failure is worth saying.
    updateAppearance({ theme, accent }).catch((error: unknown) => {
      notify({ tone: "error", message: error instanceof Error ? error.message : "The appearance could not be saved to your profile." });
    });
  }

  function commitAccent(value: string) {
    setDraft(value);
    const parsed = parseHex(value);
    if (parsed !== null) save({ accent: value.trim().toLowerCase() });
  }

  const valid = parseHex(draft) !== null;

  return (
    <Card description="Stored against your identity, so the console looks the same on every device you sign in from." title="Appearance">
      <div className="appearance">
        <div className="appearance-group">
          <span className="appearance-label" id="appearance-theme">Theme</span>
          <div aria-labelledby="appearance-theme" className="chip-row" role="group">
            {THEMES.map((option) => (
              <ChoiceChip
                icon={option.icon}
                key={option.id}
                onClick={() => save({ theme: option.id })}
                pressed={appearance.preference === option.id}
              >
                {option.label}
              </ChoiceChip>
            ))}
          </div>
        </div>

        <div className="appearance-group">
          <span className="appearance-label" id="appearance-accent">Accent</span>
          <div aria-labelledby="appearance-accent" className="accent-row" role="group">
            <label className="accent-well">
              <input
                aria-label="Pick an accent colour"
                onChange={(event) => commitAccent(event.target.value)}
                type="color"
                value={parseHex(draft) ? draft : appearance.accent}
              />
            </label>
            <TextField
              hint={valid ? undefined : "Six hex digits, for example #1a73e8."}
              label="Hex"
              mono
              onChange={(event) => commitAccent(event.target.value)}
              spellCheck={false}
              value={draft}
            />
            <Button
              disabled={appearance.accent === DEFAULT_ACCENT}
              icon="restore"
              onClick={() => { setDraft(DEFAULT_ACCENT); save({ accent: DEFAULT_ACCENT }); }}
              variant="text"
            >
              Reset
            </Button>
          </div>
          <div className="swatches">
            {SUGGESTED.map(({ name, colour }) => (
              <button
                aria-label={`${name} ${colour}`}
                aria-pressed={appearance.accent === colour}
                className="swatch"
                key={colour}
                onClick={() => { setDraft(colour); save({ accent: colour }); }}
                style={{ background: colour }}
                type="button"
              />
            ))}
          </div>
          {/* A picked colour is a hue, not a contrast ratio. When the two
              disagree the panel keeps the hue and moves the lightness, and
              says so rather than quietly painting something else. */}
          {derived?.adjusted === true && (
            <p className="appearance-note">
              Lightened or darkened for the {appearance.theme} theme so text on it stays readable. Links and buttons
              use <code>{derived.ink}</code>.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
