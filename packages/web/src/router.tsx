import { createRootRoute, createRoute, createRouter, lazyRouteComponent, redirect, type RouterHistory } from "@tanstack/react-router";
import { Layout } from "./shell/Layout.tsx";
import { SessionsView, validateSessions } from "./routes/sessions.tsx";
import { validateStats, validateWait, validateRepos, validateSkills } from "./routes/search.ts";
// Sessions (the first view) is in the shell; every other page is its own chunk, loaded when first opened (W9.0 budgets)
const root = createRootRoute({ component: Layout });
const index = createRoute({ getParentRoute: () => root, path: "/", beforeLoad: () => { throw redirect({ to: "/sessions" }); } });
const sessions = createRoute({ getParentRoute: () => root, path: "/sessions", component: SessionsView, validateSearch: validateSessions });
const stats = createRoute({ getParentRoute: () => root, path: "/stats", component: lazyRouteComponent(() => import("./routes/stats.tsx"), "StatsView"), validateSearch: validateStats });
const wait = createRoute({ getParentRoute: () => root, path: "/wait", component: lazyRouteComponent(() => import("./routes/wait.tsx"), "WaitView"), validateSearch: validateWait });
const repos = createRoute({ getParentRoute: () => root, path: "/repos", component: lazyRouteComponent(() => import("./routes/repos.tsx"), "ReposView"), validateSearch: validateRepos });
const skills = createRoute({ getParentRoute: () => root, path: "/skills", component: lazyRouteComponent(() => import("./routes/skills.tsx"), "SkillsView"), validateSearch: validateSkills });
const fleet = createRoute({ getParentRoute: () => root, path: "/fleet", component: lazyRouteComponent(() => import("./routes/fleet.tsx"), "FleetView") });
const alerts = createRoute({ getParentRoute: () => root, path: "/alerts", component: lazyRouteComponent(() => import("./routes/alerts.tsx"), "AlertsView") });
const settings = createRoute({ getParentRoute: () => root, path: "/settings", component: lazyRouteComponent(() => import("./routes/settings.tsx"), "SettingsView") });
const team = createRoute({ getParentRoute: () => root, path: "/team", component: lazyRouteComponent(() => import("./routes/team.tsx"), "TeamView") });
export function makeRouter(history?: RouterHistory) { return createRouter({ routeTree: root.addChildren([index, sessions, stats, wait, repos, skills, alerts, fleet, settings, team]), history, defaultPreload: "intent" }); }
declare module "@tanstack/react-router" { interface Register { router: ReturnType<typeof makeRouter> } }
