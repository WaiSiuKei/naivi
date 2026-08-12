#!/usr/bin/env node
// Entry shim: registers tsx so TypeScript source runs directly from a
// node_modules install (Node's native type stripping refuses .ts files
// inside node_modules, so the CLI stays prebuild-free via tsx instead).

import { register } from "tsx/esm/api";

register();
await import("../src/cli.ts");
