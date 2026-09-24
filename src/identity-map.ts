import { individualJid, type CredentialStore } from "./types.js";

type Write = { category: string; key: string; value: unknown };
const PARTNER = "identity-v2-partner",
  QUARANTINE = "identity-v2-quarantine";

/** Authenticated identity aliases and immutable published routing pins have different meanings. */
export class IdentityMap {
  constructor(private readonly store: CredentialStore) {
    this.importLegacyRelationships();
  }
  /** Diagnostic only: callers must quarantine affected identities, not freeze the entire account. */
  hasConflict() {
    return this.store.get<boolean>("identity-v2", "conflict") === true;
  }
  legacyConflictObserved() {
    return this.store.get<boolean>("identity", "conflict") === true;
  }
  isQuarantined(id: string) {
    return this.store.get<boolean>(QUARANTINE, id) === true;
  }
  resolve(id: string) {
    const previous = this.store.get<string>("canonical", id);
    if (previous) return previous;
    this.store.set("canonical", id, id);
    return id;
  }
  /** Feed only PN/LID pairs supplied by authenticated provider metadata. */
  observe(first: string | undefined, second: string | undefined): boolean {
    if (
      (first && this.isQuarantined(first)) ||
      (second && this.isQuarantined(second))
    )
      return false;
    if (
      !first ||
      !second ||
      !individualJid(first) ||
      !individualJid(second) ||
      first === second ||
      first.split("@")[1] === second.split("@")[1]
    )
      return true;
    const pn = first.endsWith("@s.whatsapp.net") ? first : second,
      lid = pn === first ? second : first;
    const oldLid = this.store.get<string>(PARTNER, pn),
      oldPn = this.store.get<string>(PARTNER, lid);
    if ((oldLid && oldLid !== lid) || (oldPn && oldPn !== pn)) {
      this.quarantine([
        pn,
        lid,
        ...(oldPn ? [oldPn] : []),
        ...(oldLid ? [oldLid] : []),
      ]);
      return false;
    }
    const a = this.store.get<string>("canonical", pn),
      b = this.store.get<string>("canonical", lid);
    const writes: Write[] = [
      { category: PARTNER, key: pn, value: lid },
      { category: PARTNER, key: lid, value: pn },
    ];
    // Once a route has been exposed, do not silently move any host's binding.
    // Two self-pins are not evidence that an authenticated alias is contradictory.
    const canonical = a ?? b ?? pn;
    if (!a) writes.push({ category: "canonical", key: pn, value: canonical });
    if (!b) writes.push({ category: "canonical", key: lid, value: canonical });
    if (a && b && a !== b)
      writes.push({ category: "identity-v2-route-split", key: pn, value: lid });
    this.store.batch(writes);
    return true;
  }
  private quarantine(ids: string[]) {
    const affected = new Set(ids);
    for (const id of affected) {
      const partner = this.store.get<string>(PARTNER, id);
      if (partner) affected.add(partner);
    }
    this.store.batch([
      { category: "identity-v2", key: "conflict", value: true },
      ...[...affected].map((key) => ({
        category: QUARANTINE,
        key,
        value: true,
      })),
    ]);
  }
  private importLegacyRelationships() {
    if (this.store.get<number>("identity-v2", "schema") === 2) return;
    const entries = this.store.identityMappings?.();
    // Alternate credential stores must expose only canonical identity metadata
    // before migrating an existing legacy map. Fresh stores have nothing to import.
    if (!entries) throw new Error("identity_metadata_migration_required");
    const graph = new Map<string, Set<string>>();
    for (const { id, canonical } of entries ?? []) {
      if (!individualJid(id) || !individualJid(canonical))
        throw new Error("identity_metadata_invalid");
      if (!graph.has(id)) graph.set(id, new Set());
      if (!graph.has(canonical)) graph.set(canonical, new Set());
      if (id !== canonical) {
        graph.get(id)!.add(canonical);
        graph.get(canonical)!.add(id);
      }
    }
    const visited = new Set<string>(),
      writes: Write[] = [];
    for (const initial of graph.keys()) {
      if (visited.has(initial)) continue;
      const component = new Set([initial]);
      for (const id of component) {
        visited.add(id);
        for (const neighbor of graph.get(id) ?? []) component.add(neighbor);
      }
      const pn = [...component].filter((id) => id.endsWith("@s.whatsapp.net")),
        lid = [...component].filter((id) => id.endsWith("@lid"));
      if (pn.length > 1 || lid.length > 1) {
        writes.push(
          { category: "identity-v2", key: "conflict", value: true },
          ...[...component].map((key) => ({
            category: QUARANTINE,
            key,
            value: true,
          })),
        );
      } else if (pn.length === 1 && lid.length === 1) {
        writes.push(
          { category: PARTNER, key: pn[0]!, value: lid[0]! },
          { category: PARTNER, key: lid[0]!, value: pn[0]! },
        );
      }
    }
    // Keep the old boolean unchanged as evidence with unknown affected scope.
    // It is superseded by concrete per-identity validation, not declared a false alarm.
    writes.push({ category: "identity-v2", key: "schema", value: 2 });
    this.store.batch(writes);
  }
}
