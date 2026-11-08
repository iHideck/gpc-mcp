import { z } from 'zod';
import { listBuilds, type Build } from './bundles.ts';
import { appPath, GpcApiError, type GpcClient } from './client.ts';
import type { PendingSummary, Play } from './edits.ts';
import { listTracks, viewOf, type ReleaseView } from './tracks.ts';

const LATEST_BUILDS = 5;
const LIFECYCLE_PREFIX = 'RELEASE_LIFECYCLE_STATE_';

const ReleaseSummary = z.object({
  releaseName: z.string().nullish(),
  releaseLifecycleState: z.string().nullish(),
  activeArtifacts: z.array(z.object({ versionCode: z.number().nullish() })).nullish(),
});
const ReleaseSummaries = z.object({ releases: z.array(ReleaseSummary).optional() });

type ReviewState = { releaseName: string | null; state: string | null; versionCodes: number[] };

type TrackStatus = { track: string; releases: ReleaseView[]; review: ReviewState[] | null };

export type ReleaseStatus = {
  packageName: string;
  builds: Build[];
  tracks: TrackStatus[];
  pending: PendingSummary | null;
  warnings: string[];
};

export async function getReleaseStatus(
  { client, edits }: Play,
  packageName: string,
): Promise<ReleaseStatus> {
  return edits.read(packageName, async (edit) => {
    const [builds, tracks] = await Promise.all([
      listBuilds(client, edit),
      listTracks(client, edit),
    ]);
    const active = tracks.filter(({ releases }) => releases.length > 0);
    const reviews = await Promise.all(
      active.map(({ track }) => readReview(client, packageName, track)),
    );
    return {
      packageName,
      builds: builds.slice(0, LATEST_BUILDS),
      tracks: active.map(({ track, releases }, index) => ({
        track,
        releases: releases.map(viewOf),
        review: reviews[index]?.review ?? null,
      })),
      pending: edits.pending(packageName),
      warnings: reviews.flatMap(({ warning }) => (warning === undefined ? [] : [warning])),
    };
  });
}

// 審査の状態が読めなくても、ビルドとリリースの状態は返す
async function readReview(
  client: GpcClient,
  packageName: string,
  track: string,
): Promise<{ review: ReviewState[] | null; warning?: string }> {
  try {
    const { releases } = await client.get(
      `${appPath(packageName)}/tracks/${encodeURIComponent(track)}/releases`,
      {},
      ReleaseSummaries,
    );
    return { review: (releases ?? []).map(reviewStateOf) };
  } catch (error) {
    if (error instanceof GpcApiError) {
      return {
        review: null,
        warning: `${track} の審査の状態を読めませんでした（${error.status}）。`,
      };
    }
    throw error;
  }
}

function reviewStateOf({
  releaseName,
  releaseLifecycleState,
  activeArtifacts,
}: z.infer<typeof ReleaseSummary>): ReviewState {
  return {
    releaseName: releaseName ?? null,
    state: releaseLifecycleState?.replace(LIFECYCLE_PREFIX, '') ?? null,
    versionCodes: (activeArtifacts ?? []).flatMap(({ versionCode }) =>
      versionCode === null || versionCode === undefined ? [] : [versionCode],
    ),
  };
}
