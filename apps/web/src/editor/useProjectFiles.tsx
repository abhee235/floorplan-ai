// File ▸ New, Open…, Open recent, Save, Save as… (ADR-012 D8): several projects in one session.
//
// The host has done all of this since the file format was built — the `project` tool takes new, open,
// save and info, writes atomically, keeps a manifest and autosaves a recovery file. None of it had a
// way in from the editor, so the app could only ever edit whatever project the command line named.
//
// Everything here goes through that tool. Nothing in the browser reads or writes a file: it asks, and
// the host answers with what it did or why it would not.

import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { projectAsked, showProject, titleFor } from "./address.js";
import type { Announcer } from "./announce.js";
import { RecoveryDialog, type UnsavedAnswer, UnsavedDialog } from "./ConfirmDialog.js";
import { ProjectDialog, type ProjectDialogMode, type RecentProject } from "./ProjectDialog.js";

/** What the hook needs from the app; a subset, so the tests can hand it a fake. */
export interface ProjectHost {
  tool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{
    ok: boolean;
    result?: unknown;
    error?: { message?: string } | undefined;
  }>;
  request(body: Record<string, unknown>): Promise<{
    ok: boolean;
    result?: unknown;
    error?: { message?: string } | undefined;
  }>;
  /** Open, make, attach to or let go of a project (ADR-020 D4). */
  workspace(body: Record<string, unknown>): Promise<{
    ok: boolean;
    result?: unknown;
    error?: { message?: string } | undefined;
  }>;
}

export interface ProjectFacts {
  /** The open project's own id (ADR-020 D1); this is what the URL carries. */
  projectId: string;
  name: string;
  path: string | null;
  modified: boolean;
  /** ISO time of unsaved work the host recovered, or null. */
  recoveryAvailable: string | null;
  /**
   * Whether the host has said what it holds yet. Until it has, `path` being null means "not asked"
   * rather than "no file", and acting on that difference is how a URL asking for a project would open
   * it over the one already there.
   */
  known: boolean;
}

export interface ProjectFilesApi {
  /** Stable for the lifetime of the editor, so command registration never goes stale. */
  actions: {
    newProject: () => Promise<void>;
    open: () => Promise<void>;
    openPath: (path: string) => Promise<void>;
    save: () => Promise<void>;
    saveAs: () => Promise<void>;
    closeProject: () => Promise<void>;
    switchTo: (projectId: string) => Promise<void>;
  };
  /** The lately-opened projects, for the Open recent submenu. */
  recent: RecentProject[];
  /** Every dialog this owns, rendered by the shell in one place. */
  dialogs: JSX.Element;
}

export function useProjectFiles(
  host: ProjectHost | null,
  facts: ProjectFacts,
  announcer: Announcer,
): ProjectFilesApi {
  const [mode, setMode] = useState<ProjectDialogMode | null>(null);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [unsaved, setUnsaved] = useState<{ action: string } | null>(null);
  const [recovery, setRecovery] = useState<string | null>(null);
  /** Resolves the promise the unsaved prompt is blocking, so the flow reads as one function. */
  const answer = useRef<((a: UnsavedAnswer) => void) | null>(null);
  /** A recovery offer is made once per file; saying no must not bring it back on the next autosave. */
  const declined = useRef(new Set<string>());

  // The newest facts, read by callbacks that must not be rebuilt when they change: the commands are
  // registered once, and a command closing over the first render's `modified` would never see a change.
  const now = useRef(facts);
  now.current = facts;
  const hostRef = useRef(host);
  hostRef.current = host;

  const ask = useCallback(async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const client = hostRef.current;
    if (!client) throw new Error("not connected to the host");
    const reply = await client.request(body);
    if (!reply.ok) throw new Error(reply.error?.message ?? "the host refused");
    return (reply.result ?? {}) as Record<string, unknown>;
  }, []);

  /** Call the project tool; throws with the host's own sentence so a dialog can show it. */
  const project = useCallback(async (args: Record<string, unknown>): Promise<void> => {
    const client = hostRef.current;
    if (!client) throw new Error("not connected to the host");
    const reply = await client.tool("project", args);
    if (!reply.ok) throw new Error(reply.error?.message ?? "the host refused");
  }, []);

  /**
   * Open, make or attach to a project (ADR-020 D4).
   *
   * Opening goes through the WORKSPACE rather than the project tool, and the difference is the whole
   * point: the tool replaces the document in this tab's session, which every other tab on this host is
   * also looking at. The workspace gives the project a session of its own and moves only this tab to
   * it, so another tab keeps the project it had.
   */
  const workspace = useCallback(
    async (body: Record<string, unknown>): Promise<{ projectId: string; name: string }> => {
      const client = hostRef.current;
      if (!client) throw new Error("not connected to the host");
      const reply = await client.workspace(body);
      if (!reply.ok) throw new Error(reply.error?.message ?? "the host refused");
      return (reply.result ?? {}) as { projectId: string; name: string };
    },
    [],
  );

  const loadRecent = useCallback(() => {
    void ask({ type: "files", op: "recent" })
      .then((body) => setRecent((body.recent as RecentProject[]) ?? []))
      .catch(() => {
        // an older host without the files message: the submenu is simply empty
      });
  }, [ask]);

  // The remembered list, once connected and again after anything that changes it.
  useEffect(() => {
    if (host) loadRecent();
  }, [host, loadRecent]);

  /**
   * Ask before throwing work away, and act on the answer. Resolves true when the caller may carry on.
   *
   * Only closing a project reaches this now. Opening one used to: it replaced the document in this
   * session, so whatever was unsaved went with it. With a session per project (ADR-020 D4) opening
   * leaves the old project open on the host, so there is nothing to warn about and the question is not
   * worth asking. Closing genuinely does let the work go.
   *
   * Saving from here can itself need the Save as dialog, and that dialog resolves later and elsewhere —
   * so a save with no path answers false and the person is left in the dialog, rather than the project
   * being closed behind it.
   */
  const mayDiscard = useCallback(
    async (action: string): Promise<boolean> => {
      if (!now.current.modified) return true;
      const said = await new Promise<UnsavedAnswer>((resolve) => {
        answer.current = resolve;
        setUnsaved({ action });
      });
      setUnsaved(null);
      answer.current = null;
      if (said === "cancel") return false;
      if (said === "discard") return true;
      if (!now.current.path) {
        setMode("save");
        return false;
      }
      try {
        await project({ op: "save" });
        announcer.say("Saved.");
        return true;
      } catch (e) {
        announcer.alert(`Nothing was saved: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    },
    [project, announcer],
  );

  const openPath = useCallback(
    async (address: string): Promise<void> => {
      // No prompt about unsaved work: nothing is discarded. The project this tab is leaving stays open
      // on the host, with everything in it, and going back to it is a link away.
      const opened = await workspace({ op: "open", address });
      announcer.say(`Opened ${opened.name}.`);
      loadRecent();
    },
    [workspace, announcer, loadRecent],
  );

  const actions = useMemo(
    () => ({
      newProject: async (): Promise<void> => {
        try {
          await workspace({ op: "new", name: "Untitled" });
          announcer.say("New project. It has no file yet; Save will ask where to put it.");
        } catch (e) {
          announcer.alert(`No new project: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
      open: async (): Promise<void> => {
        setMode("open");
      },
      openPath: async (path: string): Promise<void> => {
        try {
          await openPath(path);
        } catch (e) {
          announcer.alert(`Nothing was opened: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
      save: async (): Promise<void> => {
        // A project with no file has nowhere to go, so Save becomes Save as rather than failing.
        if (!now.current.path) {
          setMode("save");
          return;
        }
        try {
          await project({ op: "save" });
          announcer.say(`Saved to ${now.current.path}.`);
        } catch (e) {
          announcer.alert(`Nothing was saved: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
      saveAs: async (): Promise<void> => {
        setMode("save");
      },
      switchTo: async (projectId: string): Promise<void> => {
        // Nothing is saved, closed or discarded: this tab simply looks at another project the host is
        // already holding, and the one it leaves keeps everything in it (ADR-020 D4).
        if (projectId === now.current.projectId) return;
        try {
          const moved = await workspace({ op: "attach", project: projectId });
          announcer.say(`Looking at ${moved.name}.`);
        } catch (e) {
          announcer.alert(`Could not switch: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
      closeProject: async (): Promise<void> => {
        if (!(await mayDiscard("Closing it"))) return;
        try {
          await workspace({ op: "close", project: now.current.projectId });
          announcer.say("Closed. The projects still open are in File ▸ Open recent.");
        } catch (e) {
          announcer.alert(`It could not be closed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    }),
    [mayDiscard, project, openPath, workspace, announcer],
  );

  // ---- the address bar (ADR-020 D2) ---------------------------------------

  /**
   * Whether the URL's request has been acted on; until it has, nothing may overwrite it.
   *
   * State rather than a ref, and that is not a style choice. The writer below runs on a change to the
   * open project's id — but the id arrives with the SNAPSHOT, one message before the host says what it
   * holds, so by the time claiming finished the writer's dependency had already changed and settled.
   * It never ran, and a tab opened at the bare root kept a bare root in the address bar for the whole
   * session. A ref cannot wake an effect; state can.
   */
  const [claimed, setClaimed] = useState(false);

  // What the URL asks for, once the host has said what it holds. A tab arriving with a link to another
  // project opens it, which is what makes a link to a project mean anything.
  //
  // The link names an id and nothing else, so the host is asked where that project lives. A link made
  // on another machine, or before the folder was moved, still resolves — which a URL holding a path
  // could never do.
  useEffect(() => {
    if (!host || claimed || !facts.known) return;
    setClaimed(true);
    const wanted = projectAsked();
    if (wanted === null || wanted === facts.projectId) return;
    void (async () => {
      try {
        // The host is asked to attach this tab to that project, opening it if it is not open already.
        // It knows where the project lives; nothing here does, which is the point of an id.
        const opened = await workspace({ op: "attach", project: wanted });
        announcer.say(`Opened ${opened.name}.`);
        loadRecent();
      } catch (e) {
        announcer.alert(
          `That link names a project this installation has not opened before, so there is nothing to open. Use File ▸ Open to find it once, and the link will work from then on. (${
            e instanceof Error ? e.message : String(e)
          })`,
        );
        // put back what is actually open, so the address bar never lies about what is on screen
        showProject(now.current.projectId);
      }
    })();
  }, [host, claimed, facts.known, facts.projectId, workspace, announcer, loadRecent]);

  // And from then on the address bar follows what is open, however it came to be open.
  useEffect(() => {
    if (!claimed) return;
    showProject(facts.projectId.length > 0 ? facts.projectId : null);
  }, [claimed, facts.projectId]);

  // A row of tabs is unreadable when every one of them says the same thing.
  useEffect(() => {
    document.title = titleFor(facts.name, facts.modified);
  }, [facts.name, facts.modified]);

  // Work the host recovered after a crash. It has detected this since ADR-012 D6 and written it to
  // stderr, where nobody editing in a browser would ever see it.
  useEffect(() => {
    const at = facts.recoveryAvailable;
    if (!at || declined.current.has(at)) return;
    setRecovery(at);
  }, [facts.recoveryAvailable]);

  const dialogs = (
    <>
      <ProjectDialog
        mode={mode}
        onOpenChange={(open) => (open ? undefined : setMode(null))}
        ask={ask}
        currentName={facts.name}
        onChoose={async (path) => {
          if (mode === "save") {
            await project({ op: "save", path });
            announcer.say(`Saved to ${path}.`);
            loadRecent();
            return;
          }
          const opened = await workspace({ op: "open", address: path });
          announcer.say(`Opened ${opened.name}.`);
          loadRecent();
        }}
      />
      <UnsavedDialog
        open={unsaved !== null}
        action={unsaved?.action ?? ""}
        projectName={facts.name}
        hasPath={facts.path !== null}
        onAnswer={(said) => answer.current?.(said)}
      />
      <RecoveryDialog
        open={recovery !== null}
        at={recovery ?? ""}
        projectName={facts.name}
        onAnswer={(take) => {
          const at = recovery;
          setRecovery(null);
          if (at) declined.current.add(at);
          if (!take || !now.current.path) return;
          void project({ op: "open", path: now.current.path, recover: true })
            .then(() => announcer.say("The recovered work is open. Save to keep it."))
            .catch((e: unknown) =>
              announcer.alert(
                `The recovered work could not be opened: ${e instanceof Error ? e.message : String(e)}`,
              ),
            );
        }}
      />
    </>
  );

  return { actions, recent, dialogs };
}
