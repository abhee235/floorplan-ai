// The projects this installation knows about (ADR-020 D1, D3): id, where it currently lives, what it is
// called, when it was last opened.
//
// SQLite through Node's own binding, the same way the catalog is stored (ADR-008 D5). It is a library,
// not a server: there is no port, no connection string and no second process — the host opens a file in
// the data directory and reads it in-process. Nothing in the browser talks to it; the browser talks to
// the host, exactly as it did before.
//
// A table rather than the JSON list it replaces, for two reasons. An upsert is atomic, where reading a
// JSON file, changing it and writing it back races with every other host running at the same time. And
// this is precisely the "facts about projects" row of ADR-020 D3 — owner, name, when it changed — so
// when a hosted deployment arrives it becomes a Postgres table and nothing above it changes.
//
// It holds facts ABOUT projects and never a project: the drawing stays a portable `.fpviz` folder
// (ADR-012 D1), because a folder can be committed, diffed, mailed and read in ten years.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PROJECT_FILE } from "./files.js";

export const PROJECTS_DB = "projects.db";

const SCHEMA = `
create table if not exists projects (
  id             text primary key,
  address        text not null,
  name           text not null,
  created_at     text not null,
  last_opened_at text not null
);
create index if not exists projects_recent on projects(last_opened_at desc);
`;

/** One project this installation has opened. `address` is opaque above this file (ADR-020 D1). */
export interface KnownProject {
  id: string;
  address: string;
  name: string;
  createdAt: string;
  lastOpenedAt: string;
}

/** How many a menu offers. Enough to be useful, short enough to read at a glance. */
export const RECENT_LIMIT = 12;

interface Row {
  id: string;
  address: string;
  name: string;
  created_at: string;
  last_opened_at: string;
}

const projectOf = (row: Row): KnownProject => ({
  id: row.id,
  address: row.address,
  name: row.name,
  createdAt: row.created_at,
  lastOpenedAt: row.last_opened_at,
});

export class ProjectRegistry {
  constructor(readonly db: DatabaseSync) {
    db.exec("pragma journal_mode = wal;");
    db.exec(SCHEMA);
  }

  static open(dataDir: string): ProjectRegistry {
    return new ProjectRegistry(new DatabaseSync(join(dataDir, PROJECTS_DB)));
  }

  /** In memory, for tests that want a registry without a file. */
  static memory(): ProjectRegistry {
    return new ProjectRegistry(new DatabaseSync(":memory:"));
  }

  /**
   * Record that this project was opened or saved, from here.
   *
   * Keyed by the project's own id, so moving a folder updates where it lives rather than leaving a
   * second entry pointing at nothing. A copy of a project carries the original's id (the id travels in
   * the document), so opening the copy points the id at the copy — the truthful answer to "where is
   * that project now?", which is the last place it was seen.
   */
  remember(entry: { id: string; address: string; name: string; at: string }): void {
    this.db
      .prepare(
        `insert into projects (id, address, name, created_at, last_opened_at)
         values (?, ?, ?, ?, ?)
         on conflict(id) do update set
           address = excluded.address,
           name = excluded.name,
           last_opened_at = excluded.last_opened_at`,
      )
      .run(entry.id, entry.address, entry.name, entry.at, entry.at);
  }

  byId(id: string): KnownProject | null {
    const row = this.db.prepare("select * from projects where id = ?").get(id) as unknown as Row | undefined;
    return row ? projectOf(row) : null;
  }

  byAddress(address: string): KnownProject | null {
    const row = this.db.prepare("select * from projects where address = ?").get(address) as unknown as
      | Row
      | undefined;
    return row ? projectOf(row) : null;
  }

  /** The newest first, however many are asked for. */
  recent(limit = RECENT_LIMIT): KnownProject[] {
    const rows = this.db
      .prepare("select * from projects order by last_opened_at desc limit ?")
      .all(limit) as unknown as Row[];
    return rows.map(projectOf);
  }

  /**
   * The newest first, skipping any whose project is no longer on disk.
   *
   * Filtered on the way out rather than deleted, because a project on a drive that is not plugged in
   * today is still worth remembering for tomorrow. Nothing is forgotten until it is asked for.
   */
  recentPresent(limit = RECENT_LIMIT): KnownProject[] {
    return this.recent(limit * 3)
      .filter((p) => existsSync(join(p.address, PROJECT_FILE)))
      .slice(0, limit);
  }

  forget(id: string): void {
    this.db.prepare("delete from projects where id = ?").run(id);
  }

  close(): void {
    this.db.close();
  }
}
