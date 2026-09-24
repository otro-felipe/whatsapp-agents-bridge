import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BridgeStore } from "../src/store.js";
import { IdentityMap } from "../src/identity-map.js";

const pn1 = "56911111111@s.whatsapp.net",
  pn2 = "56922222222@s.whatsapp.net";
const lid1 = "11111111111@lid",
  lid2 = "22222222222@lid";
async function fixture(run: (store: BridgeStore) => void) {
  const directory = await mkdtemp(join(tmpdir(), "wa-alias-spec-"));
  const store = new BridgeStore(directory, randomBytes(32));
  try {
    run(store);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}
test("late authenticated aliases preserve both previously exposed routes without a global conflict", () =>
  fixture((store) => {
    const aliases = new IdentityMap(store.credentials("default"));
    assert.equal(aliases.resolve(pn1), pn1);
    assert.equal(aliases.resolve(lid1), lid1);
    assert.equal(aliases.observe(pn1, lid1), true);
    assert.equal(aliases.hasConflict(), false);
    assert.equal(aliases.resolve(pn1), pn1);
    assert.equal(aliases.resolve(lid1), lid1);
    const restored = new IdentityMap(store.credentials("default"));
    assert.equal(restored.observe(lid1, pn1), true);
    assert.equal(restored.resolve(lid1), lid1);
  }));
test("a legacy global flag is retained as uncertain evidence and does not relabel or stop unrelated identities", () =>
  fixture((store) => {
    const records = store.credentials("default");
    records.set("canonical", pn1, pn1);
    records.set("canonical", lid1, lid1);
    records.set("identity", "conflict", true);
    const aliases = new IdentityMap(records);
    assert.equal(aliases.legacyConflictObserved(), true);
    assert.equal(records.get("identity", "conflict"), true);
    assert.equal(aliases.observe(pn1, lid1), true);
    assert.equal(aliases.isQuarantined(pn1), false);
    assert.equal(aliases.isQuarantined(lid1), false);
    assert.equal(aliases.resolve(pn1), pn1);
    assert.equal(aliases.resolve(lid1), lid1);
    assert.equal(aliases.observe(pn2, lid2), true);
  }));
test("imports both directions of authenticated legacy relationships before accepting new pairs", () =>
  fixture((store) => {
    const records = store.credentials("default");
    records.set("canonical", pn1, pn1);
    records.set("canonical", lid1, pn1);
    const aliases = new IdentityMap(records);
    assert.equal(aliases.observe(pn1, lid2), false);
    for (const id of [pn1, lid1, lid2])
      assert.equal(aliases.isQuarantined(id), true);
    assert.equal(aliases.hasConflict(), true);
    assert.equal(aliases.isQuarantined(pn2), false);
    assert.equal(aliases.resolve(lid1), pn1);
  }));
test("imports a LID-rooted legacy relationship and quarantines an incompatible phone number", () =>
  fixture((store) => {
    const records = store.credentials("default");
    records.set("canonical", pn1, lid1);
    records.set("canonical", lid1, lid1);
    const aliases = new IdentityMap(records);
    assert.equal(aliases.observe(pn2, lid1), false);
    assert.equal(aliases.isQuarantined(pn1), true);
    assert.equal(aliases.isQuarantined(pn2), true);
    assert.equal(aliases.resolve(pn1), lid1);
  }));
test("legacy components with multiple persons stay quarantined across restart while unrelated pairs work", () =>
  fixture((store) => {
    const records = store.credentials("default");
    records.set("canonical", pn1, pn1);
    records.set("canonical", lid1, pn1);
    records.set("canonical", pn2, pn1);
    const aliases = new IdentityMap(records);
    for (const id of [pn1, pn2, lid1])
      assert.equal(aliases.isQuarantined(id), true);
    assert.equal(aliases.observe(pn1, lid1), false);
    const otherPn = "56933333333@s.whatsapp.net";
    assert.equal(aliases.observe(otherPn, lid2), true);
    assert.equal(new IdentityMap(records).isQuarantined(pn2), true);
  }));

test("refuses migration without a complete identity-only inventory even when no old conflict flag exists", () =>
  fixture((store) => {
    const records = store.credentials("default");
    records.set("canonical", pn1, pn1);
    records.set("canonical", lid1, pn1);
    const { identityMappings: _inventory, ...incomplete } = records;
    assert.throws(
      () => new IdentityMap(incomplete),
      /identity_metadata_migration_required/,
    );
    assert.equal(records.get("identity-v2", "schema"), undefined);
  }));
