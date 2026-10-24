/**
 * scripts/demoSimCoverageFake.mjs — test helper (not a test suite).
 * An in-memory `$executeRaw` for the two statements of recordSimCoverage()
 * (src/lib/demoSimCoverage.js), applied with the SAME pure reducers the SQL
 * mirrors. Any other raw SQL — or a settings id outside the reserved
 * demo-sim-participants:* prefix — throws, so the demo fakes keep proving that
 * the simulation never writes anything else.
 */
import { mergeCoverage, intersectParticipants, SIM_PARTICIPANTS_PREFIX } from "../src/lib/demoSimCoverage.js";

export function makeCoverageExecutor(tables, log = []) {
  tables.demoSimDayCoverage ||= [];
  tables.setting ||= [];
  return async (strings, ...vals) => {
    const sql = strings.join("?");
    if (/INSERT INTO "demo_sim_day_coverage"/.test(sql)) {
      const [day, at] = vals;
      const key = new Date(`${day}T00:00:00.000Z`);
      const row = tables.demoSimDayCoverage.find((r) => r.day.getTime() === key.getTime());
      const cur = row ? { firstTickAt: row.firstTickAt.getTime(), lastTickAt: row.lastTickAt.getTime(), tickCount: row.tickCount, maxGapSec: row.maxGapSec } : null;
      const next = mergeCoverage(cur, Date.parse(at));
      const out = { day: key, firstTickAt: new Date(next.firstTickAt), lastTickAt: new Date(next.lastTickAt), tickCount: next.tickCount, maxGapSec: next.maxGapSec, updatedAt: new Date() };
      if (row) Object.assign(row, out); else tables.demoSimDayCoverage.push(out);
      log.push({ table: "demo_sim_day_coverage", day });
      return 1;
    }
    if (/INSERT INTO "settings"/.test(sql)) {
      const [id, idsJson] = vals;
      if (!String(id).startsWith(SIM_PARTICIPANTS_PREFIX)) throw new Error(`NON-DEMO SETTING WRITE (raw): ${id}`);
      const row = tables.setting.find((r) => r.id === id);
      const ids = intersectParticipants(row ? row.data.ids : null, JSON.parse(idsJson));
      if (row) row.data = { ids }; else tables.setting.push({ id, data: { ids } });
      log.push({ table: "settings", id });
      return 1;
    }
    throw new Error(`UNEXPECTED RAW SQL: ${sql.slice(0, 80)}`);
  };
}
