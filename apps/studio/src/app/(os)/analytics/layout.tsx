import { Suspense, type ReactNode } from "react";
import { AnalyticsTabs } from "@/components/analytics/nav";
import { SourceNote } from "@/components/analytics/source-note";
import { PageHeader } from "@/components/shell/page-header";
import { getSources } from "@/server/queries/analytics";
import { workspace } from "@/server/workspace";

export const dynamic = "force-dynamic";

/** Analytics: your numbers in one place, each view its own route under one set of tabs. */
export default async function AnalyticsLayout({ children }: { children: ReactNode }) {
  const sources = await getSources();
  const tz = workspace().config.workspace.timezone;
  return (
    <>
      <PageHeader
        title="Analytics"
        description="How your posts are doing against your own normal, and what's working."
      />
      <div className="-mt-7 mb-6">
        <SourceNote sources={sources} tz={tz} />
      </div>
      <Suspense fallback={<div className="mb-8 h-10 border-b border-border" />}>
        <AnalyticsTabs />
      </Suspense>
      {children}
    </>
  );
}
