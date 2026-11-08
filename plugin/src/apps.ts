import { z } from 'zod';
import type { GpcClient } from './client.ts';

const App = z.object({ packageName: z.string(), displayName: z.string().nullish() });

const SearchResult = z.object({
  apps: z.array(App).optional(),
  nextPageToken: z.string().optional(),
});

export type AppSummary = { name: string | null; packageName: string };

export async function listApps(client: GpcClient): Promise<AppSummary[]> {
  const apps: AppSummary[] = [];
  let pageToken: string | undefined;
  do {
    const page = await client.getReporting(
      '/v1beta1/apps:search',
      { pageSize: '1000', ...(pageToken === undefined ? {} : { pageToken }) },
      SearchResult,
    );
    apps.push(
      ...(page.apps ?? []).map(({ packageName, displayName }) => ({
        name: displayName ?? null,
        packageName,
      })),
    );
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);
  return apps.sort((a, b) => a.packageName.localeCompare(b.packageName));
}
