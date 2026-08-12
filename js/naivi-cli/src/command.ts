// Command parsing for the naive CLI (plan 039, U1).
//
// The command model is: web (pure Vite dev), wasm (dev / --release build),
// desktop (dev / --release skeleton). Parsing is a pure function so the
// command table is unit-testable without spawning the CLI.

export type CliCommand = "web" | "wasm" | "desktop";

export interface ParsedCommand {
  /** The resolved command, or null when the argument is not a known command. */
  command: CliCommand | null;
  /** `--release` switches wasm/desktop into production mode. */
  release: boolean;
  /** `--port N` overrides the dev server port (default 3000). */
  port: number;
  /** `--devtools` injects the naive devtools overlay (wasm dev only). */
  devtools: boolean;
}

const DEFAULT_PORT = 3000;
const KNOWN_COMMANDS: readonly CliCommand[] = ["web", "wasm", "desktop"];

/** Parse the CLI arguments (argv without the node/script prefix). */
export function parseCommand(argv: readonly string[]): ParsedCommand {
  const [commandName, ...rest] = argv;
  const command = KNOWN_COMMANDS.includes(commandName as CliCommand)
    ? (commandName as CliCommand)
    : null;
  return {
    command,
    release: rest.includes("--release"),
    devtools: rest.includes("--devtools"),
    port: parsePort(rest),
  };
}

function parsePort(args: readonly string[]): number {
  const idx = args.indexOf("--port");
  if (idx >= 0 && args[idx + 1]) {
    const parsed = parseInt(args[idx + 1], 10);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed < 65536) return parsed;
  }
  return DEFAULT_PORT;
}
