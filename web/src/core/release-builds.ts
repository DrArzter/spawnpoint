import type { Preset } from "../model";

export function releaseBuildCopy(preset: Preset): { label: string; title: string; description: string; hint: string } {
  if (preset.build?.state === "starting") return {
    label: "Resume build", title: `Resume release ${preset.build.release}?`,
    description: "Resume the pending build request. AWS build time is billed; worlds are not changed.",
    hint: "Resume the same pending build request.",
  };
  if (preset.build?.state === "failed") return {
    label: "Retry build", title: `Retry release ${preset.build.release}?`,
    description: "Retry the same release from its pinned source. AWS build time is billed; worlds are not changed.",
    hint: `Retry release ${preset.build.release} from the same source.`,
  };
  return {
    label: preset.releases.length > 0 ? "Build new release" : "Build release", title: `Build ${preset.displayName}?`,
    description: "Build a new release from the published preset snapshot. AWS build time is billed; worlds are not changed.",
    hint: "Build from the pinned preset snapshot; worlds are not changed.",
  };
}

export function releaseBuildExpectation(preset: Preset): { profileDigest: string; retryRelease?: string } {
  if (preset.build && (preset.build.state === "failed" || preset.build.state === "starting")) {
    return { profileDigest: preset.build.profileDigest ?? preset.profileDigest, retryRelease: preset.build.release };
  }
  return { profileDigest: preset.profileDigest };
}
