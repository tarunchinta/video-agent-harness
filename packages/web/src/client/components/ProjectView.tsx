import { useEffect, useMemo, useState } from "react";
import { projectFileUrl } from "../../api/client.ts";
import type { FileEntry } from "../../api/contract.ts";
import { href, store, useApp } from "../store.ts";
import { FileList, FileViewer } from "./FileViewer.tsx";
import { RunTile } from "./Home.tsx";
import { Empty, Icon } from "./ui.tsx";

/** One project: its scripts, recordings and footage side by side with the runs made from it. */
export function ProjectView({ slug }: { slug: string }) {
  const project = useApp((s) => s.projects.find((p) => p.slug === slug));
  const allRuns = useApp((s) => s.runs);
  const runs = useMemo(() => allRuns.filter((r) => r.project === slug), [allRuns, slug]);
  const [selected, setSelected] = useState<FileEntry | undefined>();

  // The page is remounted for each project (keyed by slug), so this runs once per project.
  useEffect(() => {
    void store.refreshProjects();
  }, []);
  useEffect(() => {
    if (!selected && project?.files.length) {
      setSelected(project.files.find((f) => f.kind === "script") ?? project.files.find((f) => f.kind === "notes") ?? project.files[0]);
    }
  }, [project, selected]);

  if (!project) {
    return (
      <div className="page">
        <Empty icon="folder" title="No such project">
          There is no folder called projects/{slug}. <a href={href.home}>Back to your reels</a>
        </Empty>
      </div>
    );
  }
  // Footage, and recordings at the top of the folder. Sound effects and the like stay in the file list.
  const media = project.files.filter((f) => f.kind === "video" || (f.kind === "audio" && !f.path.includes("/")));

  return (
    <div className="page page-wide">
      <header className="page-head page-head-row">
        <div>
          <div className="muted small">
            <Icon name="folder" size={13} /> projects/{project.slug}
          </div>
          <h1>{project.title}</h1>
          <p className="muted">
            {project.files.length} files, {runs.length} {runs.length === 1 ? "run" : "runs"}. {project.hasNotes ? "New reels from here are given its notes." : "Add a .md or .txt file and new reels from here are given it as notes."}
          </p>
        </div>
        <a className="btn btn-primary" href={href.newRun(project.slug)}>
          <Icon name="plus" size={16} /> New reel from this project
        </a>
      </header>

      {media.length ? (
        <section className="section">
          <h2>Recordings and footage</h2>
          <div className="media-strip">
            {media.map((f) => (
              <figure key={f.path} className="media-card">
                {/* biome-ignore lint/a11y/useMediaCaption: the creator's own footage and recordings; no caption files exist for them. */}
                {f.kind === "video" ? <video src={projectFileUrl(slug, f.path)} controls preload="metadata" playsInline /> : <audio src={projectFileUrl(slug, f.path)} controls preload="metadata" />}
                <figcaption title={f.path}>{f.path}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      ) : null}

      <section className="section split">
        <div className="split-side card">
          <FileList files={project.files} selected={selected?.path} onSelect={setSelected} />
        </div>
        <div className="split-main card">{selected ? <FileViewer file={selected} url={projectFileUrl(slug, selected.path)} /> : <Empty icon="file" title="Nothing in this project yet" />}</div>
      </section>

      <section className="section">
        <h2>Runs</h2>
        {runs.length ? <div className="tiles">{runs.map((r) => <RunTile key={r.runId} run={r} showProject={false} />)}</div> : <Empty icon="film" title="No runs from this project yet">Start one, or file an existing run here from its page.</Empty>}
      </section>
    </div>
  );
}
