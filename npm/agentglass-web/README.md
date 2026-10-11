# agentglass-web

The web UI of [agentglass](https://github.com/BjoernSchotte/agentglass): your coding agents' sessions, costs and team
live in the browser. It needs `agentglass` itself (`brew install bjoernschotte/tap/agentglass`, or the install script).

```sh
npx agentglass-web --help      # or: npm i -g agentglass-web, then: agentglass web
```

`agentglass web` starts it on 127.0.0.1 and opens a one-time link. The native binary comes from a platform package
(`agentglass-web-linux-x64`, `-linux-arm64`, `-darwin-arm64`, `-darwin-x64-baseline`), an optional dependency — no
install scripts run. Docs: https://github.com/BjoernSchotte/agentglass#web-ui
