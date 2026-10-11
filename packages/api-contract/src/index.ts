// @agentglass/api-contract — the agentglass-serve/1 contract: JSON Schemas (schema/*.json, the one source), generated
// types, and validate() for tests and the BFF's debug checks.
import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
export * from "./types.gen.ts";

import alertRow from "../schema/alert-row.json" with { type: "json" };
import alertsList from "../schema/alerts-list.json" with { type: "json" };
import callGraph from "../schema/call-graph.json" with { type: "json" };
import cost from "../schema/cost.json" with { type: "json" };
import eventsList from "../schema/events-list.json" with { type: "json" };
import costRows from "../schema/cost-rows.json" with { type: "json" };
import error from "../schema/error.json" with { type: "json" };
import event from "../schema/event.json" with { type: "json" };
import fleetStatus from "../schema/fleet-status.json" with { type: "json" };
import hello from "../schema/hello.json" with { type: "json" };
import meta from "../schema/meta.json" with { type: "json" };
import page from "../schema/page.json" with { type: "json" };
import patch from "../schema/patch.json" with { type: "json" };
import request from "../schema/request.json" with { type: "json" };
import reposList from "../schema/repos-list.json" with { type: "json" };
import skillsSchema from "../schema/skills.json" with { type: "json" };
import response from "../schema/response.json" with { type: "json" };
import session from "../schema/session.json" with { type: "json" };
import sessionDetail from "../schema/session-detail.json" with { type: "json" };
import teamActivity from "../schema/team-activity.json" with { type: "json" };
import teamReport from "../schema/team-report.json" with { type: "json" };
import teamSessions from "../schema/team-sessions.json" with { type: "json" };
import teamStatus from "../schema/team-status.json" with { type: "json" };
import waitSchema from "../schema/wait.json" with { type: "json" };
import topicPage from "../schema/topic-page.json" with { type: "json" };
import presenceRow from "../schema/presence-row.json" with { type: "json" };

export const SCHEMAS = { "alert-row": alertRow, "alerts-list": alertsList, "call-graph": callGraph, cost, "cost-rows": costRows, "events-list": eventsList, error, "fleet-status": fleetStatus, event, hello, meta, page, patch, "repos-list": reposList, skills: skillsSchema, request, response, session, "session-detail": sessionDetail, "team-activity": teamActivity, "team-report": teamReport, "team-sessions": teamSessions, "team-status": teamStatus, "topic-page": topicPage, "presence-row": presenceRow, wait: waitSchema };
export type SchemaName = keyof typeof SCHEMAS;
let ajv: Ajv2020 | null = null;
function compiled(): Ajv2020 {
  if (ajv) return ajv;
  ajv = new Ajv2020({ allErrors: true, strict: false });
  for (const s of Object.values(SCHEMAS)) ajv.addSchema(s as object);
  return ajv;
}
// validate a value against a schema by name: [] when it conforms, else readable errors
export function validate(name: SchemaName, value: unknown): string[] {
  const v = compiled().getSchema(name); if (!v) return ["no schema " + name];
  if (v(value)) return [];
  return (v.errors ?? []).map((e: ErrorObject) => (e.instancePath || "/") + " " + (e.message ?? ""));
}
