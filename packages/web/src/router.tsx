import { createRootRoute, createRoute, createRouter, redirect, type RouterHistory } from "@tanstack/react-router";
import { Layout } from "./shell/Layout.tsx";
import { SessionsView, validateSessions } from "./routes/sessions.tsx";
import { SettingsView } from "./routes/settings.tsx";
import { StatsView, validateStats } from "./routes/stats.tsx";
import { AlertsView } from "./routes/alerts.tsx";
import { TeamView } from "./routes/team.tsx";
const root = createRootRoute({ component: Layout });
const index = createRoute({ getParentRoute: () => root, path: "/", beforeLoad: () => { throw redirect({ to: "/sessions" }); } });
const sessions = createRoute({ getParentRoute: () => root, path: "/sessions", component: SessionsView, validateSearch: validateSessions });
const stats = createRoute({ getParentRoute: () => root, path: "/stats", component: StatsView, validateSearch: validateStats });
const alerts = createRoute({ getParentRoute: () => root, path: "/alerts", component: AlertsView });
const settings = createRoute({ getParentRoute: () => root, path: "/settings", component: SettingsView });
const team = createRoute({ getParentRoute: () => root, path: "/team", component: TeamView });
export function makeRouter(history?: RouterHistory) { return createRouter({ routeTree: root.addChildren([index, sessions, stats, alerts, settings, team]), history, defaultPreload: false }); }
declare module "@tanstack/react-router" { interface Register { router: ReturnType<typeof makeRouter> } }
