import type { PendingSummary, Play } from './edits.ts';
import { listBuilds } from './bundles.ts';
import {
  isDraft,
  readTrack,
  viewOf,
  writeTrack,
  type Release,
  type ReleaseView,
} from './tracks.ts';

export type SelectBuildRequest = {
  packageName: string;
  track: string;
  versionCode: number;
  releaseName?: string | undefined;
};

export type SelectedBuild = {
  packageName: string;
  track: string;
  before: ReleaseView | null;
  after: ReleaseView;
  pending: PendingSummary | null;
};

export async function selectBuild(
  { client, edits }: Play,
  { packageName, track, versionCode, releaseName }: SelectBuildRequest,
): Promise<SelectedBuild> {
  return edits.write(packageName, async (edit) => {
    const [builds, current] = await Promise.all([
      listBuilds(client, edit),
      readTrack(client, edit, track),
    ]);
    if (!builds.some((build) => build.versionCode === versionCode)) {
      const known = builds.map((build) => build.versionCode).join(', ');
      throw new Error(
        known === ''
          ? `Build ${versionCode} does not exist. The app has no builds yet.`
          : `Build ${versionCode} does not exist. Existing builds: ${known}.`,
      );
    }
    const draft = current.releases.find(isDraft);
    const codes = [String(versionCode)];
    const sameBuild = draft?.versionCodes?.length === 1 && draft.versionCodes[0] === codes[0];
    const result = (after: Release): SelectedBuild => ({
      packageName,
      track,
      before: draft === undefined ? null : viewOf(draft),
      after: viewOf(after),
      pending: edits.pending(packageName),
    });
    if (draft !== undefined && sameBuild && (releaseName ?? draft.name) === draft.name) {
      return result(draft);
    }
    const { name: currentName, ...kept } = draft ?? {};
    // 別のビルドにしたら、前のビルドから Google が付けた名前を残さない
    const name = releaseName ?? (sameBuild ? currentName : undefined);
    const next: Release = {
      ...kept,
      status: 'draft',
      versionCodes: codes,
      ...(name === undefined ? {} : { name }),
    };
    const stored = await edit.change(
      `Selected build ${versionCode} for the draft release on ${track}`,
      () =>
        writeTrack(client, edit, track, [
          ...current.releases.filter((release) => !isDraft(release)),
          next,
        ]),
    );
    return result(stored.find(isDraft) ?? next);
  });
}
