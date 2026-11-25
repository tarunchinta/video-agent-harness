import { useEffect, useState } from "react";
import { Home } from "./components/Home.tsx";
import { NewRun } from "./components/NewRun.tsx";
import { ProjectView } from "./components/ProjectView.tsx";
import { RunView } from "./components/RunView.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Icon } from "./components/ui.tsx";
import { store, useApp, useRoute } from "./store.ts";

function Toast() {
  const toast = useApp((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => store.dismiss(), toast.tone === "error" ? 8000 : 3000);
    return () => clearTimeout(id);
  }, [toast]);
  if (!toast) return null;
  return (
    <div className={`toast toast-${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
      <Icon name={toast.tone === "error" ? "warn" : "check"} size={15} />
      <span>{toast.text}</span>
      <button type="button" className="icon-btn" onClick={() => store.dismiss()} aria-label="Dismiss">
        <Icon name="x" size={13} />
      </button>
    </div>
  );
}

export function App() {
  const route = useRoute();
  const [drawer, setDrawer] = useState(false);
  const pending = useApp((s) => s.runs.filter((r) => r.status === "waiting_gate").length);

  useEffect(() => {
    void store.boot();
  }, []);
  useEffect(() => {
    if (route.page !== "run") void store.openRun(undefined);
  }, [route.page]);
  // The menu drawer closes whenever you go somewhere.
  useEffect(() => {
    const close = () => setDrawer(false);
    window.addEventListener("hashchange", close);
    return () => window.removeEventListener("hashchange", close);
  }, []);
  useEffect(() => {
    document.title = pending ? `(${pending}) Reel harness` : "Reel harness";
  }, [pending]);

  return (
    <div className={`app ${drawer ? "drawer-open" : ""}`}>
      <Sidebar route={route} />
      <button type="button" className="drawer-mask" aria-label="Close the menu" onClick={() => setDrawer(false)} />
      <main className="main">
        <button type="button" className="menu-btn icon-btn" aria-label="Open the menu" onClick={() => setDrawer(true)}>
          <Icon name="menu" size={18} />
        </button>
        {route.page === "home" ? <Home /> : null}
        {route.page === "new" ? <NewRun key={route.project ?? ""} {...(route.project ? { project: route.project } : {})} /> : null}
        {route.page === "project" ? <ProjectView key={route.slug} slug={route.slug} /> : null}
        {route.page === "run" ? <RunView runId={route.runId} /> : null}
      </main>
      <Toast />
    </div>
  );
}
