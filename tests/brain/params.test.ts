/**
 * FalkorDB passes parameters as a `CYPHER name=value` prefix, so a parameter named like a Cypher keyword
 * (e.g. `$cypher`) used to break the query ("Invalid input '='"). safeParams renames those transparently.
 *
 * Run: npx tsx --test tests/brain/params.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { safeParams } from "@/lib/brain/graph";

describe("safeParams", () => {
  it("renames keyword-named parameters in both the map and the query text (the reported Finding crash)", () => {
    const q = "MERGE (f:Finding {id: $fid}) SET f.cypher = $cypher, f.turn_ref = $turnRef";
    const r = safeParams(q, { fid: "f1", cypher: "MATCH (d:Decision) WHERE x CONTAINS toLower($topic)", turnRef: null });
    assert.equal(r.cypher, "MERGE (f:Finding {id: $fid}) SET f.cypher = $p_cypher, f.turn_ref = $turnRef");
    assert.deepEqual(Object.keys(r.params).sort(), ["fid", "p_cypher", "turnRef"]);
    assert.equal(r.params.p_cypher, "MATCH (d:Decision) WHERE x CONTAINS toLower($topic)");
  });

  it("leaves normal names alone and does not touch longer names that merely start with a keyword", () => {
    const q = "MATCH (n) WHERE n.a = $cypher_text AND n.b = $cypher AND n.c = $limitx RETURN n LIMIT $limit";
    const r = safeParams(q, { cypher_text: "t", cypher: "c", limitx: 1, limit: 5 });
    assert.equal(r.cypher, "MATCH (n) WHERE n.a = $cypher_text AND n.b = $p_cypher AND n.c = $limitx RETURN n LIMIT $p_limit");
    assert.deepEqual(r.params, { cypher_text: "t", p_cypher: "c", limitx: 1, p_limit: 5 });
  });

  it("is case-insensitive about the reserved name and a no-op without parameters", () => {
    assert.equal(safeParams("RETURN $Match", { Match: 1 }).cypher, "RETURN $p_Match");
    assert.deepEqual(safeParams("RETURN 1", {}), { cypher: "RETURN 1", params: {} });
  });
});
