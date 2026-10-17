"use client";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Bookmark, X } from "lucide-react";
import { Button } from "@/components/ui";
import { toast } from "@/components/content/toast";
import { setTrendStatus } from "@/server/actions/research";

export function TrendActions({ id, status }: { id: string; status: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const run = (next: "new" | "shortlisted" | "dismissed") =>
    start(async () => {
      const res = await setTrendStatus(id, next);
      if (!res.ok) return toast(res.error, { tone: "error" });
      toast(res.message);
      router.refresh();
    });
  if (status === "kit" || status === "used" || status === "expired") return null;
  if (status === "dismissed") {
    return (
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => run("new")}>
        Restore
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-1">
      {status !== "shortlisted" ? (
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => run("shortlisted")}>
          <Bookmark className="size-3.5" />
          Shortlist
        </Button>
      ) : (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run("new")}>
          Unshortlist
        </Button>
      )}
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => run("dismissed")} aria-label="Dismiss trend" title="Dismiss">
        <X className="size-4" />
      </Button>
    </div>
  );
}
