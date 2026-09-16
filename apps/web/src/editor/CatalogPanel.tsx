// The catalog tab (ADR-017 D3: a sibling of the properties in the side panel; PRD P3-5). Search the
// catalog, narrow it by category, and pick a piece to place on the plan or to put in place of the selected
// item. The list is a combobox and listbox, so the arrows move through the results from the search field
// and Enter places the one highlighted.
//
// Searching is the host's: the tab calls the same search_catalog tool an agent does, so a person and a
// model see the same products in the same order.

import type { JSX, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  CATEGORY_CHOICES,
  type CatalogHit,
  type CatalogPage,
  categoryLabel,
  sizeText,
  trustNote,
} from "./catalog.js";
import { type Placeable, placeableOf } from "./item-tool.js";

const ALL = "all";
/** How long typing pauses before the search runs. */
const SETTLE_MS = 200;

export interface CatalogSearch {
  kind: "product" | "recipe";
  query: string;
  category?: string;
  cursor?: string;
}

export function CatalogPanel({
  inputRef,
  search,
  onPlace,
  onReplace,
  replacing,
}: {
  /** The search field, so the shell can hand it focus. cmdk sets the field's id itself. */
  inputRef?: RefObject<HTMLInputElement | null>;
  search: (args: CatalogSearch) => Promise<CatalogPage>;
  onPlace: (piece: Placeable) => void;
  onReplace: (piece: Placeable) => Promise<void>;
  /** What the selected item is called, when exactly one item is selected and so can be replaced. */
  replacing: string | null;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(ALL);
  const [products, setProducts] = useState<CatalogPage | null>(null);
  const [shapes, setShapes] = useState<CatalogHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [highlighted, setHighlighted] = useState("");
  // Answers can come back out of order; only the newest search may write its results.
  const latest = useRef(0);

  useEffect(() => {
    const ticket = (latest.current += 1);
    const scope = category === ALL ? {} : { category };
    const timer = setTimeout(() => {
      setBusy(true);
      Promise.all([search({ kind: "product", query, ...scope }), search({ kind: "recipe", query, ...scope })])
        .then(([found, generic]) => {
          if (ticket !== latest.current) return;
          setProducts(found);
          setShapes(generic.hits);
          setError(null);
        })
        .catch((e: unknown) => {
          if (ticket !== latest.current) return;
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (ticket === latest.current) setBusy(false);
        });
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [query, category, search]);

  const more = async (): Promise<void> => {
    if (!products?.cursor) return;
    const ticket = latest.current;
    const scope = category === ALL ? {} : { category };
    try {
      const next = await search({ kind: "product", query, cursor: products.cursor, ...scope });
      if (ticket !== latest.current) return;
      setProducts({ ...next, hits: [...products.hits, ...next.hits] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const hits = [...(products?.hits ?? []), ...shapes];
  const chosen = hits.find((h) => h.id === highlighted) ?? hits[0] ?? null;
  const piece = chosen ? placeableOf(chosen) : null;
  const count = products?.total ?? 0;

  return (
    <aside aria-label="Catalog" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
        <Label htmlFor="catalog-category" className="text-muted-foreground">
          Category
        </Label>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger id="catalog-category" size="sm" className="w-[168px] data-[size=sm]:h-7">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All categories</SelectItem>
            {CATEGORY_CHOICES.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Command
        shouldFilter={false}
        value={chosen?.id ?? ""}
        onValueChange={setHighlighted}
        // cmdk names its field by this label, over any aria-label the field is given
        label="Search the catalog"
        className="min-h-0 grow rounded-none border-y bg-transparent"
      >
        <CommandInput ref={inputRef} value={query} onValueChange={setQuery} placeholder="Search products" />
        {/* outside the list: a listbox holds options and nothing else */}
        <p aria-live="polite" className="px-3 pt-2 text-xs text-muted-foreground">
          {error
            ? `The catalog could not be searched: ${error}`
            : busy && !products
              ? "Searching…"
              : `${count} ${count === 1 ? "product" : "products"}${shapes.length ? `, ${shapes.length} generic` : ""}`}
        </p>
        <CommandList label="Catalog results" className="max-h-none min-h-0 grow">
          {products && products.hits.length > 0 ? (
            <CommandGroup heading="Products">
              {products.hits.map((hit) => (
                <HitRow key={hit.id} hit={hit} onPick={onPlace} />
              ))}
            </CommandGroup>
          ) : null}
          {shapes.length > 0 ? (
            <CommandGroup heading="Generic shapes">
              {shapes.map((hit) => (
                <HitRow key={hit.id} hit={hit} onPick={onPlace} />
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
        {products?.cursor ? (
          <div className="border-t px-2 py-1">
            <Button variant="ghost" size="xs" onClick={() => void more()}>
              Show more products
            </Button>
          </div>
        ) : null}
      </Command>

      {chosen && piece ? (
        <section aria-label="Picked piece" className="space-y-2 px-3 py-3">
          <div>
            <p className="font-medium leading-snug">{chosen.name}</p>
            <p className="text-xs text-muted-foreground">
              {chosen.recipe ? "Generic shape" : `${chosen.make} ${chosen.model}`} ·{" "}
              {categoryLabel(chosen.category)}
            </p>
            <Size hit={chosen} className="text-xs text-muted-foreground" />
            {trustNote(chosen) === "Unverified" ? (
              <p className="mt-1 text-xs text-[#a05a00]">Unverified: its size and price may be wrong.</p>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => onPlace(piece)}>
              Place on plan
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!replacing}
              aria-describedby={replacing ? undefined : "catalog-replace-hint"}
              onClick={() => void onReplace(piece)}
            >
              Replace selected
            </Button>
          </div>
          {/* A disabled button shows no tooltip, so why it is disabled is written out. */}
          {replacing ? null : (
            <p id="catalog-replace-hint" className="text-xs text-muted-foreground">
              Select one item on the plan to replace it.
            </p>
          )}
        </section>
      ) : null}
    </aside>
  );
}

function HitRow({
  hit,
  onPick,
}: {
  hit: CatalogHit;
  onPick: (piece: Placeable) => void;
}): JSX.Element | null {
  const piece = placeableOf(hit);
  if (!piece) return null;
  const note = trustNote(hit);
  return (
    <CommandItem value={hit.id} onSelect={() => onPick(piece)} className="items-start">
      <div className="min-w-0 grow">
        <p className="truncate font-medium">{hit.name}</p>
        <Size hit={hit} className="truncate text-xs text-muted-foreground" />
      </div>
      {note && note !== "Generic" ? (
        <span className="mt-0.5 shrink-0 rounded-sm bg-[#fff4e0] px-1 text-[11px] text-[#a05a00]">
          {note}
        </span>
      ) : null}
    </CommandItem>
  );
}

function Size({ hit, className }: { hit: CatalogHit; className: string }): JSX.Element {
  const size = sizeText(hit.dims);
  return (
    <p className={className}>
      <span aria-hidden="true">{size.shown}</span>
      <span className="sr-only">{size.said}</span>
    </p>
  );
}
