// agentglass — the platform adapter for this OS (other POSIX systems get the macOS/BSD one: ps + lsof)
// SPDX-License-Identifier: Apache-2.0
import type { Platform } from "./types.ts";
import { darwin } from "./darwin.ts";
import { linux } from "./linux.ts";

export const OS: Platform = process.platform === "linux" ? linux : darwin;
