import { z } from 'zod';
import type { PendingSummary, Play } from './edits.ts';

const CountryAvailability = z.object({
  syncWithProduction: z.boolean().optional(),
  restOfWorld: z.boolean().optional(),
  countries: z.array(z.object({ countryCode: z.string() })).optional(),
});

export type AvailabilityRequest = { packageName: string; track: string };

export type Availability = {
  packageName: string;
  track: string;
  syncWithProduction: boolean;
  restOfWorld: boolean;
  countries: string[];
  pending: PendingSummary | null;
};

export async function getAvailability(
  { client, edits }: Play,
  { packageName, track }: AvailabilityRequest,
): Promise<Availability> {
  return edits.read(packageName, async (edit) => {
    const { syncWithProduction, restOfWorld, countries } = await client.get(
      `${edit.path}/countryAvailability/${encodeURIComponent(track)}`,
      {},
      CountryAvailability,
    );
    return {
      packageName,
      track,
      syncWithProduction: syncWithProduction ?? false,
      restOfWorld: restOfWorld ?? false,
      countries: (countries ?? []).map(({ countryCode }) => countryCode),
      pending: edits.pending(packageName),
    };
  });
}
